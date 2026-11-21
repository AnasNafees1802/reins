// Reins extension: connects to the local Reins daemon and executes agent tool calls via CDP.
const PORT = 17333; // ponytail: fixed port, must match bin/reins.js
const T = new Map(); // tabId -> tab state
let ws = null, paused = false, current = null, watching = null, opened = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cdp = (tabId, method, params = {}, sessionId) =>
  chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params);

// ---------- connection ----------
function browserName() {
  const b = (navigator.userAgentData?.brands || []).map(x => x.brand).join(' ');
  return /Edge/.test(b) ? 'edge' : /Opera/.test(b) ? 'opera' : /Brave/.test(b) ? 'brave' : 'chrome';
}
function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }
function connect() {
  if (ws) return;
  const s = (ws = new WebSocket(`ws://127.0.0.1:${PORT}/ext`));
  s.onopen = () => { send({ type: 'hello', browser: browserName(), app: 'reins' }); badge(); };
  s.onmessage = e => onMsg(JSON.parse(e.data));
  s.onclose = () => { if (ws === s) ws = null; badge(); setTimeout(connect, 3000); };
}
async function onMsg(m) {
  if (m.type === 'ping') return send({ type: 'pong' });
  if (!m.id) return;
  try {
    if (paused) throw new Error('The user paused agent control in this browser (Reins toolbar icon). Ask them to resume.');
    const fn = TOOLS[m.tool];
    if (!fn) throw new Error(`Unknown tool "${m.tool}"`);
    send({ id: m.id, result: await fn(m.args || {}) });
  } catch (e) {
    send({ id: m.id, error: String(e?.message || e) });
  }
}
function badge() {
  chrome.action.setBadgeText({ text: paused ? 'II' : ws?.readyState === 1 ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: paused ? '#b45309' : '#15803d' });
}
async function setPaused(v) {
  paused = v;
  await chrome.storage.session.set({ paused });
  if (paused) for (const id of T.keys()) chrome.debugger.detach({ tabId: id }).catch(() => {});
  badge();
}
chrome.action.onClicked.addListener(() => setPaused(!paused));
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.storage.session.get('paused').then(v => { paused = !!v.paused; badge(); });
connect();

// ---------- tab + debugger state ----------
chrome.tabs.onRemoved.addListener(id => { T.delete(id); if (current === id) current = null; });
chrome.tabs.onCreated.addListener(t => { if (watching != null && t.openerTabId === watching) opened.push(t.id); });
chrome.debugger.onDetach.addListener((src, reason) => {
  T.delete(src.tabId);
  if (reason === 'canceled_by_user') setPaused(true); // user hit "Cancel" on the debugging bar: respect it
});
chrome.debugger.onEvent.addListener((src, method, p) => {
  const s = T.get(src.tabId);
  if (!s) return;
  if (method === 'Target.attachedToTarget') {
    if (p.targetInfo.type !== 'iframe') return;
    s.kids.set(p.sessionId, { parent: src.sessionId, frameId: p.targetInfo.targetId });
    setup(s, p.sessionId).catch(() => {});
  } else if (method === 'Target.detachedFromTarget') s.kids.delete(p.sessionId);
  else if (method === 'Page.javascriptDialogOpening') {
    s.dialogs.push(`${p.type} "${p.message.slice(0, 200)}" (auto-accepted)`);
    cdp(src.tabId, 'Page.handleJavaScriptDialog', { accept: true, promptText: p.defaultPrompt || '' }, src.sessionId).catch(() => {});
  } else if (method === 'Page.fileChooserOpened') s.chooser?.(p);
});

async function tabFor(a) {
  const id = a.tab ?? current;
  if (id != null) {
    try { const t = await chrome.tabs.get(+id); current = t.id; return t; }
    catch { if (a.tab != null) throw new Error(`Tab ${a.tab} not found. Use tabs {action:"list"}.`); }
  }
  let [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!/^(https?|file):/.test(t?.url || '')) { // active tab is a browser page: use the most recently used web tab
    const web = (await chrome.tabs.query({})).filter(x => /^(https?|file):/.test(x.url || ''));
    t = web.sort((x, y) => (y.lastAccessed || 0) - (x.lastAccessed || 0))[0] || t;
  }
  if (!t) throw new Error('No open tab. Use navigate with newTab:true.');
  current = t.id;
  return t;
}
async function attach(tabId) {
  let s = T.get(tabId);
  if (s) return s;
  try { await chrome.debugger.attach({ tabId }, '1.3'); }
  catch (e) {
    if (!/already attached/i.test(e.message))
      throw new Error(`Cannot control this tab (${e.message}). Browser pages like chrome://, edge:// and extension stores are off-limits; navigate to a normal site.`);
  }
  s = { tabId, kids: new Map(), ctx: new Map(), fid: new Map(), fbyn: new Map(), dialogs: [], last: null, lastOpts: null, shotScale: 1 };
  T.set(tabId, s);
  await setup(s);
  await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return s;
}
async function setup(s, sid) {
  await cdp(s.tabId, 'Page.enable', {}, sid);
  await cdp(s.tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => {});
}
async function session(a) {
  const tab = await tabFor(a);
  return attach(tab.id);
}

// ---------- frames + isolated worlds ----------
async function frames(s) {
  const oop = new Set([...s.kids.values()].map(k => k.frameId));
  const out = [];
  const walk = async sid => {
    const { frameTree } = await cdp(s.tabId, 'Page.getFrameTree', {}, sid);
    const rec = (ft, root) => {
      if (!root && oop.has(ft.frame.id)) return;
      out.push({ sid, frameId: ft.frame.id });
      (ft.childFrames || []).forEach(c => rec(c, false));
    };
    rec(frameTree, true);
  };
  await walk(undefined);
  for (const sid of s.kids.keys()) await walk(sid).catch(() => {});
  for (const f of out) {
    if (!s.fid.has(f.frameId)) s.fid.set(f.frameId, s.fid.size);
    f.n = s.fid.get(f.frameId);
    s.fbyn.set(f.n, f);
  }
  return out;
}
async function ctx(s, f) {
  let id = s.ctx.get(f.frameId);
  if (id) {
    try { await cdp(s.tabId, 'Runtime.evaluate', { expression: '1', contextId: id }, f.sid); return id; } catch {}
  }
  ({ executionContextId: id } = await cdp(s.tabId, 'Page.createIsolatedWorld', { frameId: f.frameId, worldName: 'reins', grantUniveralAccess: true }, f.sid));
  s.ctx.set(f.frameId, id);
  return id;
}
async function evalIn(s, f, expression) {
  const r = await cdp(s.tabId, 'Runtime.evaluate', { expression, contextId: await ctx(s, f), returnByValue: true, awaitPromise: true }, f.sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function topFrame(s) {
  const { frameTree } = await cdp(s.tabId, 'Page.getFrameTree');
  return { sid: undefined, frameId: frameTree.frame.id };
}

// ---------- snapshot ----------
// Runs inside each frame's isolated world. Must be self-contained (serialized with toString).
function walker(o) {
  const S = (globalThis.__reins ||= { els: [], ids: new WeakMap() });
  if (S.els.length > 20000) { S.els = []; S.ids = new WeakMap(); }
  const W = innerWidth, H = innerHeight, SW = Math.max(document.documentElement.scrollWidth, W);
  const meta = { url: location.href, title: document.title, W, H, y: Math.round(scrollY), h: document.documentElement.scrollHeight };
  if (W * H < 100) return { meta, lines: [] };
  if (o.mode === 'text') return { meta, lines: (document.body?.innerText || '').split('\n').map(l => l.trim()).filter(Boolean) };
  const lines = [];
  let text = '';
  const clean = (s, n = 80) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const flush = () => { const t = clean(text, 600); if (t && o.mode !== 'interactive' && !/^#+$/.test(t)) lines.push(t); text = ''; };
  const ref = el => { let i = S.ids.get(el); if (i === undefined) { i = S.els.push(el) - 1; S.ids.set(el, i); } return o.prefix + i; };
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'listbox', 'gridcell']);
  const FIELD = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'slider', 'file', 'switch', 'spinbutton']);
  const INPUT = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', file: 'file', range: 'slider' };
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'frame', 'head', 'object', 'embed']);

  function kind(el, cs, ptr) {
    const tag = el.localName, role = el.getAttribute('role');
    if (tag === 'input') return el.type === 'hidden' ? null : INPUT[el.type] || 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (role && ROLES.has(role)) return role;
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    if (ptr || !(el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0) || cs.cursor === 'pointer')) return null;
    // A generic wrapper around a real control: report the control, not the wrapper.
    return el.querySelector('a[href],button,input,select,textarea,[role=button],[role=link]') ? null : 'clickable';
  }
  function nameOf(el, k) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const root = el.getRootNode();
      const t = lb.split(/\s+/).map(id => root.getElementById?.(id)?.textContent || '').join(' ');
      if (t.trim()) return clean(t);
    }
    if (el.isContentEditable) return clean(el.getAttribute('title') || el.getAttribute('placeholder') || el.dataset.placeholder || '');
    if (FIELD.has(k) && el.localName !== 'div') {
      const l = el.labels?.[0];
      if (l && clean(l.innerText)) return clean(l.innerText);
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
    }
    const t = clean(el.innerText, k === 'clickable' ? 100 : 80);
    if (t) return t;
    const img = el.querySelector?.('img[alt]');
    const named = el.getAttribute('title') || img?.alt || el.querySelector?.('svg title')?.textContent || (el.localName === 'input' ? el.value : '');
    if (named) return clean(named);
    // Icon-only control: fall back to the icon's class name (e.g. "icon bi-trash").
    for (const e of [...[...(el.querySelectorAll?.('i,svg,span,use') || [])].slice(0, 6), el]) {
      const c = (e.getAttribute('class') || '') + ' ' + (e.getAttribute('href') || e.getAttribute('data-icon') || '');
      const m = [...c.matchAll(/\b(?:bi|fa|mdi|icon|ti|ri|material-icons)[-_][\w-]+|#[\w-]+/gi)].map(x => x[0]).find(x => !/-(button|btn|wrapper|container)$/i.test(x));
      if (m) return 'icon ' + m.replace(/^#/, '');
    }
    return '';
  }
  // Field label from nearby markup when it isn't linked with for=/aria (common in Vue/React UI kits).
  function labelOf(el) {
    let a = el;
    for (let i = 0; i < 4 && (a = a.parentElement); i++) {
      const others = [...a.querySelectorAll('input:not([type=hidden]),select,textarea,[role=combobox],[tabindex="0"]')].filter(x => x !== el && !el.contains(x) && !x.contains(el));
      if (others.length) return ''; // the label could belong to another control
      const l = a.querySelector('label');
      if (l && !l.contains(el)) { const t = clean(l.innerText, 50); if (t) return t; }
    }
    return '';
  }
  function attrs(el, k) {
    const a = [], tag = el.localName;
    if (tag === 'input' && !['text', 'checkbox', 'radio', 'submit', 'button', 'file', 'range'].includes(el.type)) a.push(`type=${el.type}`);
    if (k === 'textbox' || k === 'searchbox' || k === 'slider' || k === 'spinbutton' || (k === 'combobox' && tag === 'input')) {
      const v = el.isContentEditable ? el.innerText : el.value;
      if (v) a.push(`value="${el.type === 'password' ? '••••' : clean(v, 80)}"`);
    }
    if (tag === 'select') {
      const sel = el.selectedOptions?.[0];
      if (sel) a.push(`value="${clean(sel.text, 40)}"`);
      const opts = [...el.options].map(x => clean(x.text, 30));
      a.push(`options=[${opts.slice(0, 12).join('|')}${opts.length > 12 ? `|+${opts.length - 12} more` : ''}]`);
    }
    if (el.checked === true || el.getAttribute('aria-checked') === 'true') a.push('checked');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') a.push('disabled');
    const ex = el.getAttribute('aria-expanded');
    if (ex) a.push(ex === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') a.push('selected');
    if (el.required) a.push('required');
    if (k === 'link') {
      const h = el.getAttribute('href');
      if (h && !/^(javascript:|#$)/.test(h)) a.push('→' + clean(h.replace(location.origin, ''), 60));
    }
    return a.join(' ');
  }
  function walk(node, c) {
    for (let n = node.firstChild; n && lines.length < 3000; n = n.nextSibling) {
      if (n.nodeType === 3) { if (!c.quiet && !c.off) text += n.data; }
      else if (n.nodeType === 1) visit(n, c);
    }
  }
  function visit(el, c) {
    const tag = el.localName;
    if (SKIP.has(tag)) return;
    if (tag === 'slot') {
      for (const n of el.assignedNodes({ flatten: true })) n.nodeType === 1 ? visit(n, c) : !c.quiet && !c.off && (text += ' ' + n.textContent);
      return;
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || (cs.opacity === '0' && tag !== 'input')) return;
    if (cs.display === 'contents') return walk(el.shadowRoot || el, c);
    const block = !cs.display.startsWith('inline');
    if (block) flush();
    else if (cs.display !== 'inline') text += ' ';
    const r = el.getBoundingClientRect();
    const sized = r.width > 0 && r.height > 0;
    // off = not shown: outside the viewport (viewport mode) or parked where no scroll can reach (closed drawers).
    const off = !sized ? c.off : o.viewport ? !(r.bottom > 0 && r.right > 0 && r.top < H && r.left < W)
      : r.right + scrollX <= 0 || r.bottom + scrollY <= 0 || r.left + scrollX >= SW;
    const k = sized && cs.visibility !== 'hidden' ? kind(el, cs, c.ptr) : null;
    const nc = { ptr: cs.cursor === 'pointer', quiet: c.quiet, off, ctl: c.ctl };
    let dialog = false;
    if (k === 'link' && !off && o.mode !== 'interactive' && cs.display.startsWith('inline') && /\S/.test(text)) {
      text += `[${ref(el)}]"${nameOf(el, k).replace(/"/g, "'")}"`; // link mid-sentence: keep it in the sentence
      nc.quiet = true;
      walk(el.shadowRoot || el, nc);
      return;
    }
    if (k && !off) {
      flush();
      let at = attrs(el, k);
      let nm = nameOf(el, k);
      if (c.ctl && c.ctl === nm) return walk(el.shadowRoot || el, { ...nc, quiet: true, ptr: true, ctl: nm }); // same control nested in itself (tab > link)
      if ((FIELD.has(k) || k === 'clickable') && !el.getAttribute('aria-label')) {
        const lab = labelOf(el);
        if (lab && lab !== nm) nm ? (at = `(${lab}) ` + at) : (nm = lab);
      }
      nc.ctl = nm;
      if (o.mode === 'interactive' && (!nm || nm.startsWith('icon '))) { // say which row an unnamed control belongs to
        const row = el.closest('tr,[role=row],li');
        const rt = row && clean(row.innerText, 50);
        if (rt) at += ` in row "${rt.replace(/"/g, "'")}"`;
      }
      lines.push(`[${ref(el)}] ${k}${nm ? ` "${nm.replace(/"/g, "'")}"` : ''}${at ? ' ' + at.trim() : ''}`);
      if (FIELD.has(k) || tag === 'svg') return;
      // Generic clickables inside a control are the same target, except inside containers whose children are the choices.
      if (!/^(listbox|menu|menubar|tree|grid|tablist|radiogroup)$/.test(k)) nc.quiet = nc.ptr = true;
      else nc.ctl = null;
    } else if (tag === 'label' && el.control) {
      nc.quiet = true; // its text is already the control's name
    } else if (/^h[1-6]$/.test(tag) && !off) {
      text = '#'.repeat(+tag[1]) + ' ';
    } else if ((tag === 'dialog' && el.open) || /^(alert)?dialog$/.test(el.getAttribute('role') || '') || el.getAttribute('aria-modal') === 'true') {
      flush();
      lines.push(`--- dialog "${nameOf(el, 'dialog').slice(0, 60)}" ---`);
      dialog = true;
    }
    if (tag !== 'svg') walk(el.shadowRoot || el, nc);
    if (block || k) flush();
    if (dialog) lines.push('--- end dialog ---');
  }
  walk(document.body || document.documentElement, { ptr: false, quiet: false, off: false });
  flush();
  return { meta, lines };
}

const SETTLE = `new Promise(r => {
  let t; const done = () => { o.disconnect(); r(); };
  const o = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 300); });
  o.observe(document, { subtree: true, childList: true, characterData: true });
  t = setTimeout(done, 300); setTimeout(done, 1500);
})`;

async function collect(s, opts) {
  const fs = await frames(s);
  const out = [];
  let meta = null;
  for (const f of fs) {
    let r;
    try { r = await evalIn(s, f, `(${walker})(${JSON.stringify({ ...opts, prefix: f.n ? `f${f.n}e` : 'e' })})`); }
    catch { continue; }
    if (!f.n) meta = r.meta;
    if (!r.lines.length) continue;
    if (f.n) out.push(`--- iframe f${f.n} ${r.meta.url.slice(0, 80)} ---`);
    out.push(...r.lines);
  }
  return { meta, lines: out };
}
function render(meta, lines, max) {
  let text = '', i = 0;
  for (; i < lines.length && text.length + lines[i].length < max; i++) text += lines[i] + '\n';
  if (i < lines.length) text += `…truncated (${lines.length - i} more lines). Narrow it with query:"…", viewport:true or mode:"interactive".\n`;
  const head = meta ? `${meta.title.slice(0, 80)} | ${meta.url.slice(0, 150)} | viewport ${meta.W}x${meta.H}, scrollY ${meta.y}/${meta.h}\n` : '';
  return head + text;
}
async function snapshot(a, s) {
  s ||= await session(a);
  const opts = { mode: a.mode || 'full', viewport: !!a.viewport };
  const { meta, lines } = await collect(s, opts);
  if (opts.mode !== 'text') { s.last = lines; s.lastOpts = opts; s.lastUrl = meta?.url; }
  let shown = lines;
  if (a.query) {
    // "a|b" = any alternative; within one alternative, all words must appear
    const alts = a.query.toLowerCase().split('|').map(s => s.trim().split(/\s+/)).filter(w => w[0]);
    shown = lines.filter(l => { const L = l.toLowerCase(); return alts.some(ws => ws.every(w => L.includes(w))); });
    if (!shown.length) return render(meta, [], 1) + `No lines match "${a.query}" (${lines.length} lines total).`;
  }
  return render(meta, shown, a.max || 8000);
}

// After an action: report status plus what changed on the page (cheap feedback, saves a snapshot call).
async function report(s, a, note = '') {
  watching = null;
  if (opened.length) {
    const id = opened.pop();
    opened = [];
    current = id;
    await group(id);
    await loaded(id);
    return `${note}Opened new tab ${id}; it is now the target tab.\n` + (a.snapshot === false ? '' : await snapshot({ max: a.max }, await attach(id)));
  }
  let out = note;
  if (s.dialogs.length) out += 'Dialogs: ' + s.dialogs.splice(0).join('; ') + '\n';
  if (a.snapshot === false) return out + 'ok';
  if (a.snapshot === true || !s.last) return out + await snapshot({ max: a.max }, s);
  const before = s.last;
  const { meta, lines } = await collect(s, s.lastOpts);
  s.last = lines;
  if (meta && meta.url !== s.lastUrl) {
    s.lastUrl = meta.url;
    return out + 'Navigated.\n' + render(meta, lines, a.max || 8000);
  }
  const o = new Set(before), c = new Set(lines);
  const add = lines.filter(l => !o.has(l)), del = before.filter(l => !c.has(l));
  if (!add.length && !del.length) return out + `ok, no visible change | ${meta?.url.slice(0, 120)} scrollY ${meta?.y}`;
  if (add.length + del.length > 80) return out + `Page changed a lot (+${add.length}/-${del.length} lines).\n` + render(meta, lines, a.max || 8000);
  return out + `ok | changes (+${add.length}/-${del.length}):\n` + [...del.slice(0, 15).map(l => '- ' + l), ...(del.length > 15 ? [`- …${del.length - 15} more removed`] : []), ...add.map(l => '+ ' + l)].join('\n');
}

// ---------- element handles + input ----------
async function handle(a) {
  const s = await session(a);
  const m = /^(?:f(\d+))?e(\d+)$/.exec(String(a.ref || ''));
  if (!m) throw new Error(`Bad ref "${a.ref}". Use a ref like e12 from the latest snapshot.`);
  const f = s.fbyn.get(+(m[1] || 0));
  const id = f && s.ctx.get(f.frameId);
  let r = null;
  if (id) try { r = await cdp(s.tabId, 'Runtime.evaluate', { expression: `globalThis.__reins?.els[${m[2]}]`, contextId: id }, f.sid); } catch {}
  const h = { s, sid: f?.sid, objectId: r?.result?.objectId };
  if (!h.objectId || !(await call(h, 'function(){return this.isConnected}')))
    throw new Error(`Ref ${a.ref} is stale (the page changed). Take a new snapshot.`);
  return h;
}
async function call(h, fn, args = []) {
  const r = await cdp(h.s.tabId, 'Runtime.callFunctionOn', { objectId: h.objectId, functionDeclaration: fn, arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true }, h.sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const ACTIONABLE = `function(){
  const r0 = this.getBoundingClientRect();
  if (r0.top < 0 || r0.left < 0 || r0.bottom > innerHeight || r0.right > innerWidth) this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = this.getBoundingClientRect();
  if (!r.width || !r.height) return 'element has no size (hidden or collapsed)';
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) { const d = hit.shadowRoot.elementFromPoint(x, y); if (!d || d === hit) break; hit = d; }
  for (let e = hit; e; e = e.parentNode || e.host) if (e === this) return '';
  if (hit && hit.closest && hit.closest('label') && hit.closest('label').control === this) return '';
  if (!hit) return 'element is outside the visible area';
  const cls = typeof hit.className === 'string' && hit.className.trim() ? '.' + hit.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
  return 'covered by <' + hit.localName + (hit.id ? '#' + hit.id : '') + cls + '> "' + (hit.innerText || '').trim().slice(0, 50) + '"';
}`;
async function point(h, force) {
  let why = '';
  for (let i = 0; i < 8; i++) {
    why = await call(h, ACTIONABLE);
    if (!why || force) break;
    await sleep(250);
  }
  if (why && !force) throw new Error(`Cannot click: ${why}. Close the overlay/dialog first, or pass force:true.`);
  const { quads } = await cdp(h.s.tabId, 'DOM.getContentQuads', { objectId: h.objectId }, h.sid);
  if (!quads?.length) throw new Error('Element has no clickable area.');
  const q = quads[0];
  let x = (q[0] + q[2] + q[4] + q[6]) / 4, y = (q[1] + q[3] + q[5] + q[7]) / 4;
  for (let sid = h.sid; sid;) { // out-of-process iframes: add the iframe's offset in its parent
    const k = h.s.kids.get(sid);
    if (!k) break;
    const { backendNodeId } = await cdp(h.s.tabId, 'DOM.getFrameOwner', { frameId: k.frameId }, k.parent);
    const { model } = await cdp(h.s.tabId, 'DOM.getBoxModel', { backendNodeId }, k.parent);
    x += model.content[0]; y += model.content[1];
    sid = k.parent;
  }
  return { x, y };
}
async function mouse(s, x, y, { button = 'left', clicks = 1, move = false } = {}) {
  await cdp(s.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  if (move) return;
  const buttons = { left: 1, right: 2, middle: 4 }[button];
  for (let i = 1; i <= clicks; i++) {
    await cdp(s.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: i });
    await cdp(s.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i });
  }
}
const KEYS = { Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34], Insert: [45], ' ': [32, ' '] };
const MODS = { Alt: [1, 18], Control: [2, 17], Ctrl: [2, 17], Meta: [4, 91], Cmd: [4, 91], Shift: [8, 16] };
function keydef(k) {
  if (k === 'Space') k = ' ';
  if (k === 'Esc') k = 'Escape';
  if (KEYS[k]) return { key: k, code: k === ' ' ? 'Space' : k, keyCode: KEYS[k][0], text: KEYS[k][1] };
  if (/^F\d{1,2}$/.test(k)) return { key: k, code: k, keyCode: 111 + +k.slice(1) };
  if ([...k].length === 1) {
    const u = k.toUpperCase();
    return { key: k, code: /[A-Z]/.test(u) ? 'Key' + u : /\d/.test(k) ? 'Digit' + k : '', keyCode: /[A-Z0-9]/.test(u) ? u.charCodeAt(0) : 0, text: k };
  }
  throw new Error(`Unknown key "${k}". Use names like Enter, Tab, Escape, ArrowDown, Control+a.`);
}
async function press(s, combo) {
  const parts = combo === '+' ? ['+'] : combo.split('+').map((p, i, all) => p === '' && i === all.length - 1 ? '+' : p).filter(Boolean);
  const name = parts.pop();
  let modifiers = 0;
  for (const p of parts) {
    const m = MODS[p[0].toUpperCase() + p.slice(1).toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}"`);
    modifiers |= m[0];
    await cdp(s.tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: p, windowsVirtualKeyCode: m[1], modifiers });
  }
  const d = keydef(name);
  // ponytail: Ctrl/Alt shortcuts send no text; Blink maps them to editing commands on Windows/Linux. macOS would need the `commands` field.
  let text = modifiers & 7 ? undefined : d.text;
  if (text && modifiers & 8) text = text.toUpperCase();
  const ev = { modifiers, key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, text, unmodifiedText: text };
  await cdp(s.tabId, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...ev });
  await cdp(s.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  for (const p of parts.reverse()) await cdp(s.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: p, windowsVirtualKeyCode: MODS[p[0].toUpperCase() + p.slice(1).toLowerCase()][1], modifiers: 0 });
}
async function settle(s) {
  await sleep(150);
  for (let i = 0; i < 100; i++) {
    const t = await chrome.tabs.get(s.tabId).catch(() => null);
    if (!t || t.status === 'complete') break;
    await sleep(100);
  }
  try { await evalIn(s, await topFrame(s), SETTLE); } catch {}
}
async function loaded(tabId, timeout = 30000) {
  const end = Date.now() + timeout;
  await sleep(200);
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') break;
    await sleep(150);
  }
  const s = await attach(tabId).catch(() => null);
  if (s) await settle(s);
  return s;
}
async function group(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    const [g] = await chrome.tabGroups.query({ title: 'Reins', windowId: t.windowId });
    const gid = await chrome.tabs.group({ tabIds: tabId, ...(g ? { groupId: g.id } : { createProperties: { windowId: t.windowId } }) });
    if (!g) await chrome.tabGroups.update(gid, { title: 'Reins', color: 'orange' });
  } catch {}
}
function jsWrap(code) { return /\breturn\b|;/.test(code) ? code : `return (${code});`; }
function fmt(v, max = 4000) {
  const t = v === undefined ? 'undefined' : typeof v === 'string' ? v : JSON.stringify(v, null, 1);
  return t.length > max ? t.slice(0, max) + `…(${t.length} chars)` : t;
}

// ---------- tools ----------
const TOOLS = {
  reload() { setTimeout(() => chrome.runtime.reload(), 200); return 'Reloading extension'; }, // dev: pick up code changes

  // Several actions in one agent turn. Intermediate steps report only notable events; the last step reports the
  // diff for the whole sequence (s.last is untouched until then). Stops at the first failure.
  async batch(a) {
    const steps = a.steps || [], notes = [];
    if (!steps.length) throw new Error('batch needs a non-empty steps array, e.g. [{"tool":"click","ref":"e5"}]');
    for (const [i, st] of steps.entries()) {
      const { tool, ...args } = st;
      if (!TOOLS[tool] || tool === 'batch' || tool === 'reload') throw new Error(`Step ${i + 1}: unknown tool "${tool}"`);
      const last = i === steps.length - 1;
      try {
        const r = await TOOLS[tool]({ tab: a.tab, ...args, snapshot: last ? a.snapshot ?? args.snapshot : false });
        const text = typeof r === 'string' ? r : r.text;
        if (last) return typeof r === 'string' ? [...notes, r].join('\n') : { ...r, text: [...notes, r.text].join('\n') };
        if (text !== 'ok') notes.push(`${i + 1}. ${tool}: ${text.split('\n').slice(0, 3).join(' | ')}`);
      } catch (e) {
        const s = await session({ tab: a.tab }).catch(() => null);
        return [...notes, `Step ${i + 1} (${tool}) failed: ${e.message}. Steps before it succeeded.`, s ? await report(s, {}) : ''].join('\n');
      }
    }
    return 'ok';
  },

  async tabs(a) {
    const act = a.action || 'list';
    if (act === 'new') {
      const t = await chrome.tabs.create({ url: a.url ? normUrl(a.url) : 'about:blank', active: a.background !== true });
      current = t.id;
      await group(t.id);
      if (!a.url) return `Opened tab ${t.id}`;
      const s = await loaded(t.id);
      return `Opened tab ${t.id}\n` + (s ? await snapshot({ max: a.max }, s) : '');
    }
    if (act === 'switch') {
      const t = await chrome.tabs.update(+a.tab, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      current = t.id;
      return `Target tab is now ${t.id}: ${t.title} | ${t.url}`;
    }
    if (act === 'close') {
      const id = +(a.tab ?? current);
      await chrome.tabs.remove(id);
      if (current === id) current = null;
      return `Closed tab ${id}`;
    }
    const all = await chrome.tabs.query({});
    return all.map(t => `${t.id === current ? '*' : ' '}${t.id}${t.active ? ' (active)' : ''} ${(t.title || '').slice(0, 60)} | ${(t.url || '').slice(0, 100)}`).join('\n') + '\n(* = agent target tab)';
  },

  async navigate(a) {
    let tab = a.newTab ? null : await tabFor(a);
    if (a.newTab) {
      if (!a.url) throw new Error('newTab needs a url.');
      tab = (await chrome.windows.getAll()).length
        ? await chrome.tabs.create({ url: normUrl(a.url), active: true })
        : (await chrome.windows.create({ url: normUrl(a.url), focused: true })).tabs[0]; // browser running with no window
      current = tab.id;
      await group(tab.id);
    } else if (a.back) await chrome.tabs.goBack(tab.id);
    else if (a.forward) await chrome.tabs.goForward(tab.id);
    else if (a.reload) await chrome.tabs.reload(tab.id);
    else if (a.url) await chrome.tabs.update(tab.id, { url: normUrl(a.url) });
    else throw new Error('Give url, back, forward or reload.');
    const s = await loaded(tab.id, a.timeout);
    const t = await chrome.tabs.get(tab.id);
    if (!s) return `Loaded ${t.url} (browser page; cannot be inspected)`;
    return a.snapshot === false ? `Loaded ${t.title} | ${t.url}` : snapshot(a, s);
  },

  snapshot: a => snapshot(a),

  async click(a) {
    const s = await session(a);
    watching = s.tabId;
    if (a.ref) {
      const h = await handle(a);
      const p = await point(h, a.force);
      await mouse(s, p.x, p.y, { button: a.button, clicks: a.double ? 2 : 1 });
    } else if (a.x != null && a.y != null) {
      await mouse(s, a.x / s.shotScale, a.y / s.shotScale, { button: a.button, clicks: a.double ? 2 : 1 });
    } else throw new Error('Give ref, or x and y from the last screenshot.');
    await settle(s);
    return report(s, a);
  },

  async hover(a) {
    const h = await handle(a);
    const p = await point(h, true);
    await mouse(h.s, p.x, p.y, { move: true });
    await settle(h.s);
    return report(h.s, a);
  },

  async type(a) {
    if (a.text != null) a.text = String(a.text); // CLI/JSON may hand us numbers
    const h = await handle(a), s = h.s;
    watching = s.tabId;
    const FOCUSED = 'function(){ this.focus(); let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a === this || this.contains(a); }';
    if (!(await call(h, FOCUSED))) { const p = await point(h, a.force); await mouse(s, p.x, p.y); }
    if (a.clear !== false) {
      await call(h, `function(){
        if (typeof this.select === 'function' && 'value' in this) this.select();
        else { const r = document.createRange(); r.selectNodeContents(this); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
      }`);
      if (!a.text) await press(s, 'Delete');
    }
    if (a.text) {
      if (a.slowly) for (const ch of a.text) await press(s, ch === '\n' ? 'Enter' : ch);
      else await cdp(s.tabId, 'Input.insertText', { text: a.text });
    }
    if (a.submit) await press(s, 'Enter');
    await settle(s);
    return report(s, a);
  },

  async press(a) {
    const s = await session(a);
    watching = s.tabId;
    if (a.ref) await call(await handle(a), 'function(){ this.focus(); }');
    for (const k of [].concat(a.keys || a.key)) await press(s, k);
    await settle(s);
    return report(s, a);
  },

  async select(a) {
    const h = await handle(a);
    const err = await call(h, `function(v){
      if (this.localName !== 'select') return 'not a <select>; click it, then click the option';
      const opts = [...this.options], V = String(v).toLowerCase();
      const o = opts.find(o => o.value === v || o.text.trim() === v) || opts.find(o => o.text.toLowerCase().includes(V));
      if (!o) return 'no option matching "' + v + '". Options: ' + opts.map(o => o.text.trim()).join(' | ');
      this.focus(); this.value = o.value; o.selected = true;
      this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }));
      return '';
    }`, [String(a.value)]);
    if (err) throw new Error(err);
    await settle(h.s);
    return report(h.s, a);
  },

  async scroll(a) {
    const s = await session(a);
    let x, y;
    if (a.ref) {
      const h = await handle(a);
      if (!a.direction) {
        await call(h, "function(){ this.scrollIntoView({ block: 'center', behavior: 'instant' }); }");
        await settle(s);
        return report(s, a);
      }
      ({ x, y } = await point(h, true));
    }
    const { cssLayoutViewport: v } = await cdp(s.tabId, 'Page.getLayoutMetrics');
    x ??= v.clientWidth / 2; y ??= v.clientHeight / 2;
    const dir = a.direction || 'down', amt = (a.amount ?? 0.8) * (/left|right/.test(dir) ? v.clientWidth : v.clientHeight);
    const sign = /up|left/.test(dir) ? -1 : 1;
    await cdp(s.tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: /left|right/.test(dir) ? sign * amt : 0, deltaY: /up|down/.test(dir) ? sign * amt : 0 });
    await sleep(300);
    await settle(s);
    return report(s, a);
  },

  async upload(a) {
    const h = await handle(a), s = h.s;
    const files = [].concat(a.paths);
    if (await call(h, "function(){ return this.localName === 'input' && this.type === 'file'; }")) {
      await cdp(s.tabId, 'DOM.setFileInputFiles', { files, objectId: h.objectId }, h.sid);
    } else {
      await cdp(s.tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
      try {
        const chosen = new Promise((res, rej) => { s.chooser = res; setTimeout(() => rej(new Error('Clicking that element did not open a file chooser. Pass the ref of the upload button or the file input.')), 5000); });
        const p = await point(h, true);
        await mouse(s, p.x, p.y);
        const { backendNodeId } = await chosen;
        await cdp(s.tabId, 'DOM.setFileInputFiles', { files, backendNodeId });
      } finally {
        s.chooser = null;
        await cdp(s.tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      }
    }
    await settle(s);
    return report(s, a, `Attached ${files.length} file(s).\n`);
  },

  async screenshot(a) {
    const s = await session(a);
    const { cssVisualViewport: v } = await cdp(s.tabId, 'Page.getLayoutMetrics');
    const scale = Math.min(1, (a.maxWidth || 1280) / v.clientWidth);
    // clip.scale is multiplied by the screen's device scale factor, which page zoom hides from JS.
    // So measure the real output and correct once per tab (s.dsf).
    const z = await chrome.tabs.getZoom(s.tabId); // clip is in zoomed units, layout metrics are not
    const grab = async k => {
      const shot = cdp(s.tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: a.quality || 60, clip: { x: v.pageX * z, y: v.pageY * z, width: v.clientWidth * z, height: v.clientHeight * z, scale: k / z } });
      const { data } = await Promise.race([shot, sleep(10000).then(() => { throw new Error('Screenshot timed out; the tab is probably in the background. Use tabs {action:"switch"} first.'); })]);
      return { data, ...jpegSize(data) };
    };
    let img = await grab(scale / (s.dsf || 1));
    const dsf = img.w / (v.clientWidth * scale / (s.dsf || 1));
    if (Math.abs(dsf - (s.dsf || 1)) > 0.02) { s.dsf = dsf; img = await grab(scale / dsf); }
    s.shotScale = img.w / v.clientWidth;
    return { text: `Screenshot ${img.w}x${img.h}. To click a spot, pass its image x,y to click.`, image: img.data };
  },

  async eval(a) {
    const code = jsWrap(a.code || a.expression);
    if (a.ref) return fmt(await call(await handle(a), `async function(){ const el = this; ${code} }`), a.max);
    const s = await session(a);
    const r = await cdp(s.tabId, 'Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return fmt(r.result.value, a.max);
  },

  async wait(a) {
    const s = await session(a);
    if (a.ms) { await sleep(a.ms); return report(s, a); }
    const end = Date.now() + (a.timeout || 15000);
    const want = a.gone ? false : true;
    while (Date.now() < end) {
      let ok = true;
      if (a.url) ok = (await chrome.tabs.get(s.tabId)).url.includes(a.url);
      if (ok && a.text) ok = (await evalIn(s, await topFrame(s), `(document.body?.innerText || '').includes(${JSON.stringify(a.text)})`).catch(() => false)) === want;
      if (ok) { await settle(s); return report(s, a); }
      await sleep(300);
    }
    throw new Error(`Timed out after ${a.timeout || 15000}ms waiting for ${a.url ? `url~"${a.url}" ` : ''}${a.text ? `text "${a.text}" ${want ? 'to appear' : 'to disappear'}` : ''}`);
  },
};
function jpegSize(b64) {
  const b = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  for (let i = 2; i + 8 < b.length && b[i] === 0xff;) {
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  throw new Error('Could not read screenshot size');
}
function normUrl(u) { return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u; }
