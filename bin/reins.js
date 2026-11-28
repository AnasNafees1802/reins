#!/usr/bin/env node
// Reins: local daemon (bridges agents <-> browser extension), MCP stdio server, and CLI.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const PORT = +process.env.REINS_PORT || 17333; // ponytail: fixed port, must match extension/background.js (REINS_PORT is for tests)
const EXT_ID = 'ggjpcidlnhbhdjajedgegjcnpnialhco'; // pinned by the "key" in extension/manifest.json
const DIR = path.join(os.homedir(), '.reins');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NO_EVENTS = 'No watch events yet.';
const RELATIVE_TIME = /\b(\d+|an?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|[smhdwy])\s+ago\b|\bjust now\b/gi;
// Who is calling. Each MCP server process is one agent session, so it gets its own id (and its own tab).
// CLI calls share "cli" unless REINS_AGENT is set.
let AGENT = process.env.REINS_AGENT || 'cli';
// The user, typing in a terminal: memory they write is approved, and only they can review what agents wrote.
// MCP calls (where a prompt-injected agent acts) never count. An agent with a shell could still fake a terminal
// call on purpose; this guards the tool path, not a deliberately hostile process.
let USER = !!(process.stdin.isTTY && process.stdout.isTTY);

function token() {
  fs.mkdirSync(DIR, { recursive: true });
  const f = path.join(DIR, 'token');
  try { return fs.readFileSync(f, 'utf8').trim(); }
  catch { const t = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(f, t, { mode: 0o600 }); return t; }
}

// ---------- daemon ----------
function serve() {
  const { WebSocketServer } = require('ws');
  const TOKEN = token(), browsers = [], old = new Set();
  const last = new Map(); // agent -> browser it last used
  let seq = 0;
  const pick = (name, agent) => name
    ? browsers.find(b => b.name === name) || browsers.find(b => b.name.startsWith(name))
    : browsers.includes(last.get(agent)) ? last.get(agent) : browsers[0];
  const ask = (b, tool, args, agent, ms = 60000) => new Promise(resolve => {
    const id = ++seq;
    const t = setTimeout(() => { b.pending.delete(id); resolve({ error: `Timed out after ${ms / 1000}s` }); }, ms);
    b.pending.set(id, m => { clearTimeout(t); resolve(m); });
    b.ws.send(JSON.stringify({ id, tool, args, agent }));
  });
  const noBrowser = name => browsers.length
    ? `No browser "${name}". Connected: ${browsers.map(x => x.name).join(', ')}`
    : 'No browser connected. Open Chrome or Edge with the Reins extension installed (toolbar badge shows ON).';

  // ---------- watchers: poll a tab, queue an event when it changes, optionally run a command ----------
  // ponytail: watchers live in daemon memory, so a daemon restart drops them (tab ids do not survive a browser restart anyway).
  const watches = new Map(), events = [], waiters = [];
  let wseq = 0;
  const describe = w => w.text ? `text "${w.text}" to ${w.gone ? 'disappear' : 'appear'}`
    : w.query ? `changes in lines matching "${w.query}"` : 'any change in the page text';
  const drop = w => { clearInterval(w.timer); watches.delete(w.id); };
  function fire(w, url, detail) {
    const at = new Date().toISOString();
    const ev = { watch: w.id, agent: w.agent, name: w.name, tab: w.tab, url, at, text: `watch ${w.id}${w.name ? ` "${w.name}"` : ''} fired on tab ${w.tab} (${url}) at ${at}:\n${detail}` };
    console.log(at, 'watch fired', w.id);
    events.push(ev);
    if (events.length > 100) events.shift();
    [...waiters].forEach(f => f());
    if (w.run) {
      // The event holds page content: hand it over as a file, never inside the command line (cmd.exe would expand and parse it).
      const f = path.join(DIR, 'events', `${w.id}-${Date.now()}.json`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(ev, null, 2));
      require('child_process').spawn(w.run, { shell: true, stdio: 'inherit', windowsHide: true, env: { ...process.env, REINS_EVENT_FILE: f } })
        .on('error', e => console.log(at, 'watch run failed', w.id, e.message));
    }
    if (w.once) drop(w);
  }
  function see(w, { url, lines }) {
    if (w.text) {
      const hit = lines.join('\n').includes(w.text) !== !!w.gone;
      if (hit && !w.prev) fire(w, url, `text "${w.text}" ${w.gone ? 'disappeared' : 'appeared'}`);
      w.prev = hit;
      return;
    }
    // Compare with relative times ("3 minutes ago") blanked: they tick on their own and would fire every check.
    const now = new Map(lines.map(l => [l.replace(RELATIVE_TIME, 'ago'), l]));
    if (w.prev) {
      const add = [...now].filter(([k]) => !w.prev.has(k)).map(([, l]) => l), del = [...w.prev].filter(([k]) => !now.has(k)).map(([, l]) => l);
      if (add.length || del.length) fire(w, url, [...del.slice(0, 20).map(l => '- ' + l), ...add.slice(0, 40).map(l => '+ ' + l)].join('\n'));
    }
    w.prev = now;
  }
  async function check(w) {
    if (w.busy) return;
    w.busy = true;
    try {
      const b = browsers.find(x => x.name === w.browser);
      if (!b) throw new Error(`browser ${w.browser} is not connected`);
      const r = await ask(b, 'probe', { tab: w.tab, query: w.query, reload: w.reload }, 'watch');
      if (r.error) throw new Error(r.error);
      w.checks++;
      w.error = null;
      see(w, r.result);
    } catch (e) {
      w.error = e.message;
      if (/not found/.test(e.message)) { w.once = true; fire(w, '', `stopped watching: ${e.message}`); }
    } finally { w.busy = false; }
  }
  async function watch(msg) {
    const a = msg.args || {}, act = a.action || 'list';
    if (act === 'add') {
      if (a.gone && !a.text) return { error: 'gone needs text.' };
      const b = pick(msg.browser, msg.agent);
      if (!b) return { error: noBrowser(msg.browser) };
      const r = await ask(b, 'probe', { tab: a.tab, query: a.query }, msg.agent);
      if (r.error) return r;
      const every = Math.max(2, +a.every || 60);
      const w = { id: 'w' + ++wseq, name: a.name, browser: b.name, tab: r.result.tab, text: a.text, gone: !!a.gone, query: a.query,
        every, reload: !!a.reload, once: a.once !== false, run: a.run, checks: 1, prev: null, agent: msg.agent };
      watches.set(w.id, w);
      see(w, r.result); // baseline; a text condition that already holds fires right away
      if (watches.has(w.id)) w.timer = setInterval(() => check(w), every * 1000);
      return { result: `Watching ${w.id}${w.name ? ` "${w.name}"` : ''} on tab ${w.tab} every ${every}s for ${describe(w)}${w.once ? ' (once)' : ''}.${watches.has(w.id) ? '' : ' It fired already.'} Get events with watch {action:"wait"}.` };
    }
    // Each agent sees only its own watches and events, so parallel agents never take each other's.
    const mine = () => events.filter(e => e.agent === msg.agent), own = [...watches.values()].filter(w => w.agent === msg.agent);
    if (act === 'wait') {
      const end = Date.now() + Math.min(+a.timeout || 240000, 240000); // the client loops for longer waits
      while (!mine().length && Date.now() < end) await new Promise(r => {
        const f = () => { clearTimeout(t); waiters.splice(waiters.indexOf(f) >>> 0, 1); r(); };
        const t = setTimeout(f, end - Date.now());
        waiters.push(f);
      });
      const got = mine();
      got.forEach(e => events.splice(events.indexOf(e), 1));
      return { result: got.length ? got.map(e => e.text).join('\n\n') : NO_EVENTS };
    }
    if (act === 'remove') {
      const hit = own.filter(w => a.all || w.id === a.id || (a.name && w.name === a.name));
      hit.forEach(drop);
      return { result: `Removed ${hit.length} watch(es).` };
    }
    if (act !== 'list') return { error: `Unknown action "${act}". Use add, list, wait or remove.` };
    const lines = own.map(w => `${w.id}${w.name ? ` "${w.name}"` : ''} tab ${w.tab} (${w.browser}) every ${w.every}s: ${describe(w)}${w.once ? ' (once)' : ''}${w.reload ? ', reloads' : ''}${w.run ? `, runs: ${w.run}` : ''} | ${w.checks} checks${w.error ? ` | last error: ${w.error}` : ''}`);
    const n = mine().length;
    return { result: (lines.join('\n') || 'No watches.') + (n ? `\n${n} event(s) waiting: watch {action:"wait"}` : '') };
  }

  // ---------- memory: site notes and recipes every agent shares (bin/memory.js holds the store) ----------
  // Agents (MCP) write only for the site their tab is on, and what they write waits for the user's approval
  // (reins review). msg.user is true only for the CLI run in an interactive terminal; see callTool.
  const { createStore, siteOf, fill, checkSteps } = require('./memory');
  const mem = createStore(path.join(DIR, 'memory'));
  const seen = new Map(); // agent -> { url of its target tab, sites it was shown memory for, last call time }
  const state = agent => {
    let s = seen.get(agent);
    if (!s) {
      s = { url: null, sites: new Set(), t: 0 };
      seen.set(agent, s);
      if (seen.size > 300) [...seen].sort((x, y) => x[1].t - y[1].t).slice(0, 50).forEach(([k]) => seen.delete(k)); // drop the longest idle
    }
    s.t = Date.now();
    return s;
  };
  const current = agent => { const u = seen.get(agent)?.url; try { return u ? siteOf(u) : null; } catch { return null; } };
  // Where a write goes. The user may name any site; an agent only its own tab's site, so a page can only ever
  // plant memory for itself.
  function target(a, msg) {
    if (msg.user) {
      const site = a.site ? siteOf(a.site) : current(msg.agent);
      if (!site) throw new Error('Pass site:"example.com".');
      return site;
    }
    const cur = current(msg.agent);
    if (!cur) throw new Error('Open the site first: memory is saved for the site your tab is on.');
    if (a.site && siteOf(a.site) !== cur) throw new Error(`You can only save memory for the site your tab is on (${cur}). Only the user can write memory for ${a.site === '*' ? 'every site' : a.site}, from a terminal.`);
    return cur;
  }
  const visible = (x, msg) => msg.user || x.approved || x.by === msg.agent;
  // The extension reports the agent's tab URL with each reply. The first reply on each site with memory carries it,
  // so an agent learns what earlier agents found without asking (and without spending a turn).
  function withHint(agent, r, tool) {
    if (!r.url) return r;
    const s = state(agent);
    s.url = r.url;
    let site;
    try { site = siteOf(r.url); } catch { return r; } // chrome://, file:, about:blank
    if (r.error || tool === 'eval' || s.sites.has(site)) return r; // eval output is data the agent parses: keep it clean
    const first = !s.sites.size;
    s.sites.add(site);
    const h = mem.hint(site, { all: first, agent });
    if (!h) return r;
    if (typeof r.result === 'string') r.result += '\n\n' + h;
    else if (r.result && typeof r.result.text === 'string') r.result.text += '\n\n' + h;
    return r;
  }
  function memory(msg) {
    const a = msg.args || {}, act = a.action || 'recall';
    if (act === 'remember') {
      const site = target(a, msg), { note, added } = mem.remember(site, a.text, { approved: msg.user, by: msg.user ? 'user' : msg.agent });
      return `${added ? 'Remembered' : 'Already remembered'} for ${site === '*' ? 'every site' : site} (id ${note.id}).` + (note.approved
        ? ` Every agent sees it when it opens ${site === '*' ? 'any site' : site}.`
        : ' Other agents see it once the user approves it: tell them to run "reins review" in a terminal.');
    }
    if (act === 'forget') { // agents may only take back their own pending notes
      const n = mem.forget(a.id || a.text, a.site && siteOf(a.site), x => msg.user || (!x.approved && x.by === msg.agent));
      return `Forgot ${n} note(s).` + (n || msg.user ? '' : ' Agents can only forget their own notes that are still pending; ask the user to remove others.');
    }
    if (act === 'pending' || act === 'approve' || act === 'reject') {
      if (!msg.user) throw new Error('Only the user reviews memory, from a terminal: reins review');
      if (act === 'pending') return JSON.stringify(mem.pending());
      return mem.review(a.kind, siteOf(a.site), a.key, act === 'approve') ? 'ok' : 'not found';
    }
    if (act === 'list' || (act === 'recall' && !a.site && !current(msg.agent))) {
      const waiting = mem.pending().length;
      const lines = mem.sites().map(s => [s, mem.notes(s).filter(x => visible(x, msg)).length, mem.recipes(s).filter(x => visible(x, msg)).length])
        .filter(([, n, r]) => n || r).map(([s, n, r]) => `${s}: ${n} note(s), ${r} recipe(s)`);
      return (lines.length ? lines.join('\n') + '\nRead one with memory {site:"…"}.' : 'No memory yet. Save facts with memory {action:"remember", text} and workflows with recipe {action:"save"}.') +
        (waiting ? `\n${waiting} item(s) wait for the user to approve them: reins review` : '');
    }
    if (act !== 'recall') throw new Error(`Unknown action "${act}". Use recall, remember, forget or list.`);
    const site = a.site ? siteOf(a.site) : current(msg.agent);
    return mem.hint(site, { all: true, agent: msg.user ? undefined : msg.agent }) || `No notes or recipes for ${site} yet.`;
  }
  async function recipe(msg) {
    const a = msg.args || {}, act = a.action || 'list';
    const find = () => {
      const r = mem.findRecipe(a.name, a.site ? siteOf(a.site) : current(msg.agent));
      if (!visible(r, msg)) throw new Error(`Recipe "${r.name}" was saved by another agent and waits for the user to approve it (reins review).`);
      return r;
    };
    if (act === 'list') {
      const sites = a.site ? [siteOf(a.site)] : mem.sites();
      const lines = sites.flatMap(s => mem.recipes(s).filter(r => visible(r, msg)).map(r => `${s} ${r.name}${r.params.length ? `(${r.params.join(', ')})` : ''}: ${r.description || `${r.steps.length} steps`} | ${r.runs} runs${r.approved ? '' : ', pending review'}${r.lastError ? `, last run failed: ${r.lastError}` : ''}`));
      return lines.join('\n') || 'No recipes yet. After a multi-step task that will come up again, save it with recipe {action:"save", name, steps}.';
    }
    if (act === 'get') return JSON.stringify(find(), null, 1);
    if (act === 'delete') {
      const site = target(a, msg), r = mem.recipe(site, a.name);
      if (!r) return `No recipe "${a.name}" for ${site}.`;
      if (!msg.user && (r.approved || r.by !== msg.agent)) throw new Error('Agents can only delete their own recipes that are still pending. Ask the user.');
      mem.deleteRecipe(site, a.name);
      return `Deleted recipe "${a.name}".`;
    }
    const b = pick(msg.browser, msg.agent);
    if (act === 'save') {
      const site = target(a, msg);
      let steps = a.steps;
      // Refs only last for one page load: swap them for role+name locators read from the agent's latest snapshot.
      const refs = Array.isArray(steps) ? steps.map(s => s?.ref).filter(Boolean) : [];
      if (refs.length) {
        if (!b) throw new Error(noBrowser(msg.browser));
        const r = await ask(b, 'locators', { refs }, msg.agent);
        if (r.error) throw new Error(r.error);
        const miss = refs.filter(x => !r.result[x]);
        if (miss.length) throw new Error(`${miss.join(', ')} not in your latest snapshot. Take a snapshot, or write find:{role, name} yourself.`);
        steps = steps.map(({ ref, ...s }) => ref ? { ...s, find: r.result[ref] } : s);
      }
      const { recipe: r, replaced } = mem.saveRecipe(site, { name: a.name, description: a.description, steps, approved: msg.user, by: msg.user ? 'user' : msg.agent });
      return `${replaced ? 'Updated' : 'Saved'} recipe "${r.name}" for ${site === '*' ? 'every site' : site}: ${r.steps.length} steps${r.params.length ? `, params ${r.params.join(', ')}` : ''}.\n` +
        `Run it: recipe {action:"run", name:"${r.name}"${r.params.length ? `, params:{${r.params.map(p => `${p}:"…"`).join(', ')}}` : ''}}` +
        (r.approved ? '' : '\nYou can run it now. Other agents can once the user approves it: tell them to run "reins review" in a terminal.');
    }
    if (act !== 'run') throw new Error(`Unknown action "${act}". Use run, save, list, get or delete.`);
    const r = find(), cur = current(msg.agent);
    // A recipe acts on the site it was made for: open that site first. Every-site recipes ("*") only press and click.
    if (r.site !== '*' && r.site !== cur) throw new Error(`Recipe "${r.name}" is for ${r.site}, but your tab is on ${cur || 'no site yet'}. Open ${r.site} first.`);
    checkSteps(r.steps, r.site); // again: the file may have been edited by hand
    const steps = fill(r.steps, a.params || {});
    if (!b) throw new Error(noBrowser(msg.browser));
    const out = withHint(msg.agent, await ask(b, 'batch', { steps, tab: a.tab, snapshot: a.snapshot }, msg.agent,
      120000 + steps.reduce((n, s) => n + (+s.timeout || +s.ms || 0), 0)));
    const text = out.error || (typeof out.result === 'string' ? out.result : out.result?.text) || '';
    const failed = out.error || /^Step \d+ \(\w+\) failed: .*/m.exec(text)?.[0];
    mem.recordRun(r.site, r.name, failed);
    if (failed) {
      const tip = `\nRecipe "${r.name}" did not finish; the site may have changed. Finish the task by hand, then fix the recipe: recipe {action:"save", name:"${r.name}", steps:[…]} (same name replaces it).`;
      if (out.error) out.error += tip; else if (typeof out.result === 'string') out.result += tip; else out.result.text += tip;
    }
    return out;
  }
  // Daemon-side tools reply {result} or {error}; recipe run passes the extension's reply through.
  const local = async (fn, msg) => {
    try { const r = await fn(msg); return typeof r === 'string' ? { result: r } : r; }
    catch (e) { return { error: e.message }; }
  };

  const server = http.createServer(async (req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    // Web pages always send Origin; agents never do. The token blocks other local processes.
    if (req.headers.origin || req.headers['x-reins-token'] !== TOKEN) return reply(403, { error: 'forbidden' });
    if (req.url === '/status') return reply(200, { browsers: browsers.map(b => b.name), old: [...old] });
    if (req.url !== '/call' || req.method !== 'POST') return reply(404, { error: 'not found' });
    let body = '';
    for await (const c of req) body += c;
    let msg;
    try { msg = JSON.parse(body); } catch { return reply(400, { error: 'bad json' }); }
    if (msg.tool === 'watch') return reply(200, await watch(msg));
    if (msg.tool === 'memory') return reply(200, await local(memory, msg));
    if (msg.tool === 'recipe') return reply(200, await local(recipe, msg));
    if (msg.tool === 'probe' || msg.tool === 'locators') return reply(200, { error: `${msg.tool} is internal` });
    const b = pick(msg.browser, msg.agent);
    if (!b) return reply(200, { error: noBrowser(msg.browser) });
    last.set(msg.agent, b);
    reply(200, withHint(msg.agent, await ask(b, msg.tool, msg.args || {}, msg.agent, (msg.args?.timeout || 0) + 60000), msg.tool));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 << 20 });
  const ORIGIN = new RegExp(`^(chrome-)?extension://${EXT_ID}$`);
  server.on('upgrade', (req, sock, head) => {
    if (req.url !== '/ext' || !ORIGIN.test(req.headers.origin || '')) return sock.destroy();
    wss.handleUpgrade(req, sock, head, ws => {
      const b = { ws, name: null, pending: new Map() };
      const ping = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 20000); // keeps the MV3 worker alive
      ws.on('message', d => {
        let m;
        try { m = JSON.parse(d); } catch { return; }
        if (m.type === 'hello') {
          if (m.app !== 'reins') { old.add(m.browser); return; } // pre-rename build: must be reloaded from ~/.reins/extension
          old.delete(m.browser);
          let n = m.browser, i = 2;
          while (browsers.some(x => x.name === n)) n = `${m.browser}-${i++}`;
          b.name = n;
          browsers.push(b);
          console.log(new Date().toISOString(), 'connected', n);
        } else if (m.id) { b.pending.get(m.id)?.(m); b.pending.delete(m.id); }
      });
      ws.on('close', () => {
        clearInterval(ping);
        browsers.splice(browsers.indexOf(b) >>> 0, browsers.includes(b) ? 1 : 0);
        for (const r of b.pending.values()) r({ error: 'Browser disconnected mid-call' });
        console.log(new Date().toISOString(), 'disconnected', b.name);
      });
    });
  });
  server.on('error', e => { if (e.code === 'EADDRINUSE') { console.error(`Reins daemon already running on ${PORT}`); process.exit(0); } throw e; });
  server.listen(PORT, '127.0.0.1', () => console.log(`Reins daemon on 127.0.0.1:${PORT}`));
}

// ---------- client ----------
async function request(p, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-reins-token': token(), 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  return r.json();
}
async function ensureDaemon() {
  try { return await request('/status'); } catch {}
  const log = fs.openSync(path.join(DIR, 'daemon.log'), 'a');
  require('child_process').spawn(process.execPath, [__filename, 'serve'], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try { return await request('/status'); } catch {}
  }
  throw new Error('Could not start the Reins daemon. Run: node bin/reins.js serve');
}
async function callTool(tool, args) {
  const { browser, ...rest } = args;
  let st = await ensureDaemon();
  // Calls the daemon answers by itself do not wait for a browser to connect.
  const daemonOnly = (tool === 'watch' && rest.action !== 'add') || tool === 'memory' || (tool === 'recipe' && !/^(run|save)$/.test(rest.action || 'list'));
  // A sleeping extension reconnects on its 30s alarm; wait for it instead of failing the first call.
  for (let i = 0; !daemonOnly && !st.browsers.length && i < 70; i++) { await sleep(500); st = await request('/status'); }
  const t0 = Date.now();
  // watch wait: the daemon holds each request up to 4 minutes, so loop for longer waits (timeout 0 = until an event).
  const wait = tool === 'watch' && rest.action === 'wait', end = rest.timeout === 0 ? Infinity : t0 + (rest.timeout ?? 60000);
  let r;
  do r = await request('/call', { tool, args: wait ? { ...rest, timeout: Math.min(end - Date.now(), 240000) } : rest, browser, agent: AGENT, user: USER });
  while (wait && r.result === NO_EVENTS && Date.now() < end - 1000);
  const out = r.error ? { text: 'Error: ' + r.error } : typeof r.result === 'string' ? { text: r.result } : r.result;
  if (process.env.REINS_METER) // per-call usage log for cost tracking of long-running agents
    fs.appendFileSync(process.env.REINS_METER, JSON.stringify({ ts: t0, ms: Date.now() - t0, tool, args: rest, text: out.text, image: !!out.image, imageBytes: out.image?.length }) + '\n');
  if (r.error) throw new Error(r.error);
  return out;
}

// ---------- tool schemas ----------
const ref = { type: 'string', description: 'Element ref from the latest snapshot, e.g. e12 or f1e5' };
const tab = { type: 'number', description: 'Tab id. Default: your own target tab (each agent session gets its own)' };
const browser = { type: 'string', description: 'chrome, edge, ... (only when several browsers are connected)' };
const after = { type: 'boolean', description: 'Default returns a diff of what changed. true = full snapshot, false = nothing' };
const find = { type: 'object', description: 'Instead of ref: the role and name as the snapshot shows them, e.g. {role:"button", name:"Save"}; nth:2 picks the second match. Survives reloads and new sessions, so recipes use it',
  properties: { role: { type: 'string' }, name: { type: 'string' }, nth: { type: 'number' } } };
const tool = (name, description, properties, required = []) =>
  ({ name, description, inputSchema: { type: 'object', properties: { ...properties, tab, browser }, required } });
const TOOLS = [
  tool('tabs', 'List, open, switch to (focus) or close tabs. use = make a tab your target without bringing it to the front. The * tab is yours; tabs marked "other agent" belong to parallel agents, leave them alone.', {
    action: { type: 'string', enum: ['list', 'new', 'use', 'switch', 'close'] }, url: { type: 'string' }, background: { type: 'boolean' } }),
  tool('navigate', 'Load a URL (or back/forward/reload) in the target tab and return a snapshot.', {
    url: { type: 'string' }, newTab: { type: 'boolean' }, back: { type: 'boolean' }, forward: { type: 'boolean' }, reload: { type: 'boolean' },
    snapshot: { type: 'boolean', description: 'false to skip the snapshot' }, max: { type: 'number' } }),
  tool('snapshot', 'Compact page outline: text plus [ref] lines for interactive elements, across iframes and shadow DOM. Cheaper than a screenshot.', {
    mode: { type: 'string', enum: ['full', 'interactive', 'text'], description: 'interactive = refs only; text = readable page text' },
    viewport: { type: 'boolean', description: 'Only what is on screen' }, query: { type: 'string', description: 'Only lines containing all these words; "a|b" = either. Plain words, not a regex' },
    max: { type: 'number', description: 'Char budget, default 8000' }, all: { type: 'boolean', description: 'While a modal dialog is open, also show the page behind it' }, hrefs: { type: 'boolean', description: 'Show link URLs (off by default to save tokens)' } }),
  tool('click', 'Real mouse click on a ref (scrolls into view, checks nothing covers it) or at x,y of the last screenshot.', {
    ref, find, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' }, button: { type: 'string', enum: ['left', 'right', 'middle'] },
    force: { type: 'boolean', description: 'Click even if covered' }, snapshot: after }),
  tool('type', 'Type into a field (replaces its content unless clear:false).', {
    ref, find, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean', description: 'Press Enter after' },
    slowly: { type: 'boolean', description: 'Key-by-key, for widgets that need keystrokes' }, snapshot: after }),
  tool('press', 'Press keys: "Enter", "Escape", "Control+a", "Shift+Tab". Optional ref to focus first.', {
    key: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } }, ref, find, snapshot: after }),
  tool('select', 'Choose an option in a native <select> by value or visible text.', { ref, find, value: { type: 'string' }, snapshot: after }, ['value']),
  tool('choose', 'Pick from a custom dropdown in one call: clicks ref to open it, waits for the option with this text to appear, scrolls it into view and clicks it. Works for native <select> too.', {
    ref, find, option: { type: 'string', description: 'Visible text of the item to pick' }, force: { type: 'boolean' }, snapshot: after }, ['option']),
  tool('hover', 'Move the mouse over a ref (menus, tooltips).', { ref, find, snapshot: after }),
  tool('scroll', 'Scroll the page, or the scrollable area under ref. With ref and no direction: scroll ref into view.', {
    ref, find, direction: { type: 'string', enum: ['down', 'up', 'left', 'right'] }, amount: { type: 'number', description: 'Screens, default 0.8' }, snapshot: after }),
  tool('upload', 'Attach local files via a file input or an upload button ref.', {
    ref, find, paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths' }, snapshot: after }, ['paths']),
  tool('screenshot', 'JPEG of the visible viewport. Use only when layout/visuals matter; snapshot is cheaper.', {
    maxWidth: { type: 'number', description: 'Default 1280' }, quality: { type: 'number', description: '1-100, default 60' } }),
  tool('eval', 'Run JavaScript in the page and return the JSON result. With ref, `el` is that element. Use `return` for multi-statement code.', {
    code: { type: 'string' }, ref, find, max: { type: 'number' } }, ['code']),
  tool('batch', 'Run several actions in ONE call, e.g. fill a whole form and click Save. Each step is {tool, ...args} for click/type/press/select/choose/hover/scroll/upload/wait/navigate/eval/snapshot. Stops at the first failure. Returns one diff for the whole sequence. A step can target an element that only appears mid-batch with find:{role, name} instead of ref.', {
    steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' } }, required: ['tool'] } }, snapshot: after }, ['steps']),
  tool('wait','Wait until text appears (or is gone) or the URL contains a string; or sleep ms.', {
    text: { type: 'string' }, gone: { type: 'boolean' }, url: { type: 'string' }, ms: { type: 'number' }, timeout: { type: 'number' }, snapshot: after }),
  tool('network', "Record the tab's XHR/fetch calls, read one (credential headers masked), and replay it with changes. Replay calls the site's own API as the user, often one call instead of many clicks.", {
    action: { type: 'string', enum: ['start', 'list', 'get', 'replay', 'stop'], description: 'start (reload:true catches page-load calls), list (default), get id, replay id, stop' },
    id: { type: 'number', description: 'Request # from list' }, reload: { type: 'boolean' }, query: { type: 'string', description: 'list: only matching lines' },
    all: { type: 'boolean', description: 'list: include documents, scripts, images' },
    url: { type: 'string', description: 'replay: another URL' }, method: { type: 'string', description: 'replay: another method' },
    body: { description: 'replay: new body (string or JSON)' }, headers: { type: 'object', description: 'replay: headers to add or override' }, max: { type: 'number' } }),
  tool('console', "Capture the tab's console messages, uncaught exceptions and failed loads. start first; read (default) returns what arrived since the last read.", {
    action: { type: 'string', enum: ['start', 'read', 'stop'] }, max: { type: 'number' } }),
  tool('watch', 'Watch a tab in the background and queue an event when text appears or disappears, or when lines matching query change. wait blocks until an event arrives.', {
    action: { type: 'string', enum: ['add', 'list', 'wait', 'remove'] }, text: { type: 'string' }, gone: { type: 'boolean', description: 'Fire when text disappears' },
    query: { type: 'string', description: 'Only watch lines with these words (a|b = either)' }, every: { type: 'number', description: 'Seconds between checks, default 60' },
    reload: { type: 'boolean', description: 'Reload the tab before each check, for pages that do not update live' },
    once: { type: 'boolean', description: 'Remove after the first event (default true)' }, name: { type: 'string' },
    id: { type: 'string', description: 'remove: watch id' }, all: { type: 'boolean', description: 'remove: all watches' },
    timeout: { type: 'number', description: 'wait: ms, default 60000; 0 = until an event' },
    run: { type: 'string', description: 'CLI only: shell command to run on each event; it gets REINS_EVENT_FILE' } }),
  tool('memory', 'Notes about websites, shared by every agent on this machine. Opening a site that has notes or recipes shows them in the reply. Remember facts that would save the next agent turns (the API a site calls, where a setting hides, a step that needs slowly:true). You can only save for the site your tab is on, and other agents see it after the user approves it. Never secrets or personal data.', {
    action: { type: 'string', enum: ['recall', 'remember', 'forget', 'list'], description: 'recall (default): notes + recipes for a site; list: every site with memory' },
    text: { type: 'string', description: 'remember: one fact, at most 500 chars' }, id: { type: 'string', description: 'forget: note id' },
    site: { type: 'string', description: 'recall: another site to read. Default: the site of your current tab' } }),
  tool('recipe', 'Saved workflows any agent can run later in ONE call: a list of batch steps. After a multi-step task that will come up again, save it. Refs in steps become role+name locators automatically; write {{param}} in values to fill at run time. Steps act on the page only (no eval or upload) and stay on the site of the recipe. A recipe runs on its own site, and other agents can run yours after the user approves it.', {
    action: { type: 'string', enum: ['run', 'save', 'list', 'get', 'delete'] }, name: { type: 'string', description: 'Letters, digits, - and _' },
    description: { type: 'string', description: 'save: what it does, one line' },
    steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' } }, required: ['tool'] }, description: 'save: batch steps, e.g. [{tool:"click", find:{role:"button", name:"New issue"}}, {tool:"type", find:{role:"textbox", name:"Title"}, text:"{{title}}"}]' },
    params: { type: 'object', description: 'run: values for the {{params}}' },
    site: { type: 'string', description: 'list/get: another site. Default: the site of your current tab' }, snapshot: after }),
];

// ---------- MCP stdio server ----------
function mcp() {
  AGENT = process.env.REINS_AGENT || `mcp-${process.pid}`;
  USER = false;
  const out = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  require('readline').createInterface({ input: process.stdin }).on('line', async line => {
    let m;
    try { m = JSON.parse(line.replace(/^﻿/, '')); } catch { return; }
    const { id, method, params } = m;
    if (method === 'initialize') return out({ id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'reins', version: '1.0.0' },
      instructions: 'Controls the user\'s real Chrome/Edge (their logged-in sessions). Load the reins skill for the workflow.' } });
    if (method === 'tools/list') return out({ id, result: { tools: TOOLS } });
    if (method === 'ping') return out({ id, result: {} });
    if (method === 'tools/call') {
      try {
        // A watch command runs a shell on the user's machine: only the user sets that up, from the CLI.
        if (params.name === 'watch' && params.arguments?.run) throw new Error('run is CLI only. Give the user the command to run in a terminal: reins watch action=add ... run="..."');
        const r = await callTool(params.name, params.arguments || {});
        const content = [{ type: 'text', text: r.text || '' }];
        if (r.image) content.push({ type: 'image', data: r.image, mimeType: 'image/jpeg' });
        return out({ id, result: { content } });
      } catch (e) {
        return out({ id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } });
      }
    }
    if (id !== undefined) out({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  });
}

// ---------- install: agents + extension ----------
const HOME = os.homedir(), ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(DIR, 'extension'); // stable path: moving or updating the package never breaks the browser's copy
const SERVER = { command: process.execPath, args: [__filename, 'mcp'] };
const exists = p => fs.existsSync(p);
const readJson = p => exists(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
const writeJson = (p, j) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(j, null, 2)); };

// A /reins command for agents whose slash menu lists command files, not skills. `task` is the agent's
// placeholder for what the user typed after the command (agents without one append it themselves).
const SLASH_DESC = "Drive my real Chrome or Edge with Reins";
const slash = task => `Use Reins for this: drive the user's real, already-running Chrome or Edge (their logged-in sessions and open tabs) with the reins MCP tools, following the reins skill if you have it. Start with tabs or snapshot.\n\nTask: ${task}\n`;
const slashMd = (task = 'what the user wrote after this command') => `---\ndescription: ${SLASH_DESC}\n---\n${slash(task)}`;
const slashToml = () => `description = "${SLASH_DESC}"\nprompt = """\n${slash('{{args}}')}"""\n`;

// Each agent: where it lives (to detect it), how to register the MCP server, where its skills go,
// and cmd: [file, text] for the /reins command where the slash menu does not already list skills.
const AGENTS = [
  { name: 'Claude Code', home: '.claude', skills: '.claude/skills', add() {
      const cp = require('child_process'), o = { stdio: 'ignore', shell: process.platform === 'win32' && !onPath('claude.exe') }; // npm-installed claude is a .cmd shim
      const q = s => o.shell ? `"${s}"` : s;
      cp.spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'reins'], o);
      const r = cp.spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'reins', '--', q(SERVER.command), q(__filename), 'mcp'], o);
      if (r.status !== 0) throw new Error('`claude` CLI not found on PATH');
    } },
  { name: 'Codex', home: '.codex', skills: '.codex/skills', cmd: ['.codex/prompts/reins.md', slashMd('$ARGUMENTS')], add() {
      const p = path.join(HOME, '.codex/config.toml');
      const q = s => `'${s}'`; // TOML literal strings: no escaping of Windows backslashes
      const block = `[mcp_servers.reins]\ncommand = ${q(SERVER.command)}\nargs = [${SERVER.args.map(q).join(', ')}]\ntool_timeout_sec = 120\n`;
      const t = exists(p) ? fs.readFileSync(p, 'utf8') : '';
      const re = /^\[mcp_servers\.reins\][\s\S]*?(?=^\[|(?![\s\S]))/m; // up to the next table header at line start
      fs.writeFileSync(p, re.test(t) ? t.replace(re, block + '\n') : t.trimEnd() + '\n\n' + block);
    } },
  { name: 'OpenCode', home: '.config/opencode', skills: '.config/opencode/skills', cmd: ['.config/opencode/command/reins.md', slashMd('$ARGUMENTS')], add() {
      const d = path.join(HOME, '.config/opencode');
      const p = ['opencode.json', 'opencode.jsonc'].map(f => path.join(d, f)).find(exists) || path.join(d, 'opencode.json');
      const j = readJson(p);
      (j.mcp ||= {}).reins = { type: 'local', command: [SERVER.command, ...SERVER.args], enabled: true, timeout: 120000 };
      writeJson(p, j);
    } },
  { name: 'Antigravity', home: '.gemini/config', skills: '.gemini/config/skills', cmd: ['.gemini/config/global_workflows/reins.md', slashMd()], add() {
      const p = path.join(HOME, '.gemini/config/mcp_config.json'), j = readJson(p);
      (j.mcpServers ||= {}).reins = SERVER;
      writeJson(p, j);
    } },
  { name: 'Gemini CLI', home: '.gemini/settings.json', skills: '.gemini/skills', cmd: ['.gemini/commands/reins.toml', slashToml()], add() {
      const p = path.join(HOME, '.gemini/settings.json'), j = readJson(p);
      (j.mcpServers ||= {}).reins = { ...SERVER, timeout: 120000 };
      writeJson(p, j);
    } },
  { name: 'Cursor', home: '.cursor', skills: '.cursor/skills', cmd: ['.cursor/commands/reins.md', slashMd()], add() {
      const p = path.join(HOME, '.cursor/mcp.json'), j = readJson(p);
      (j.mcpServers ||= {}).reins = SERVER;
      writeJson(p, j);
    } },
  { name: 'Windsurf', home: '.codeium/windsurf', skills: null, cmd: ['.codeium/windsurf/global_workflows/reins.md', slashMd()], add() {
      const p = path.join(HOME, '.codeium/windsurf/mcp_config.json'), j = readJson(p);
      (j.mcpServers ||= {}).reins = SERVER;
      writeJson(p, j);
    } },
];

// Chromium browsers: Firefox and Safari lack chrome.debugger, so they cannot be supported.
const PF = process.env.ProgramFiles || '', PF86 = process.env['ProgramFiles(x86)'] || '', LAD = process.env.LOCALAPPDATA || '';
const BROWSERS = [
  { id: 'chrome', name: 'Chrome', page: 'chrome://extensions', exe: { win32: [`${PF}/Google/Chrome/Application/chrome.exe`, `${PF86}/Google/Chrome/Application/chrome.exe`, `${LAD}/Google/Chrome/Application/chrome.exe`], darwin: ['/Applications/Google Chrome.app'], linux: ['google-chrome', 'google-chrome-stable'] } },
  { id: 'edge', name: 'Edge', page: 'edge://extensions', exe: { win32: [`${PF86}/Microsoft/Edge/Application/msedge.exe`, `${PF}/Microsoft/Edge/Application/msedge.exe`], darwin: ['/Applications/Microsoft Edge.app'], linux: ['microsoft-edge'] } },
  { id: 'brave', name: 'Brave', page: 'brave://extensions', exe: { win32: [`${PF}/BraveSoftware/Brave-Browser/Application/brave.exe`, `${LAD}/BraveSoftware/Brave-Browser/Application/brave.exe`], darwin: ['/Applications/Brave Browser.app'], linux: ['brave-browser'] } },
  { id: 'opera', name: 'Opera', page: 'opera://extensions', exe: { win32: [`${LAD}/Programs/Opera/opera.exe`], darwin: ['/Applications/Opera.app'], linux: ['opera'] } },
];
const onPath = c => require('child_process').spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { stdio: 'ignore' }).status === 0;
const findExe = b => (b.exe[process.platform] || []).find(p => process.platform === 'linux' ? onPath(p) : exists(p));
function openPage(exe, url) {
  const cp = require('child_process');
  if (process.platform === 'darwin') cp.spawn('open', ['-a', exe, url], { detached: true, stdio: 'ignore' }).unref();
  else cp.spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref();
}
function clipboard(text) {
  const cmd = { win32: 'clip', darwin: 'pbcopy', linux: 'xclip -selection clipboard' }[process.platform];
  try { require('child_process').execSync(cmd, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); return true; } catch { return false; }
}

async function install(opts) {
  console.log('Reins install\n\n1. Agents');
  for (const a of AGENTS) {
    if (!exists(path.join(HOME, a.home))) continue;
    try {
      a.add();
      if (a.skills) {
        const d = path.join(HOME, a.skills, 'reins');
        fs.mkdirSync(d, { recursive: true });
        fs.copyFileSync(path.join(ROOT, 'skill/SKILL.md'), path.join(d, 'SKILL.md'));
      }
      if (a.cmd) {
        const f = path.join(HOME, a.cmd[0]);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, a.cmd[1]);
      }
      console.log(`   ✓ ${a.name} (tools${a.skills ? ' + skill' : ''} + /reins)`);
    } catch (e) { console.log(`   ✗ ${a.name}: ${e.message}`); }
  }
  if (exists(path.join(HOME, '.agents'))) { // shared skills folder some agents read
    fs.mkdirSync(path.join(HOME, '.agents/skills/reins'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'skill/SKILL.md'), path.join(HOME, '.agents/skills/reins/SKILL.md'));
  }
  console.log('   Restart open agents so they load the new tools.');

  fs.cpSync(path.join(ROOT, 'extension'), EXT_DIR, { recursive: true });
  let st = await ensureDaemon();
  for (const browser of st.browsers) await request('/call', { tool: 'reload', args: {}, browser }).catch(() => {}); // pick up updated extension files
  if (opts.extension === false) return;

  console.log('\n2. Browser extension');
  const found = BROWSERS.map(b => ({ ...b, exe: findExe(b) })).filter(b => b.exe);
  await sleep(2500);
  st = await request('/status');
  const todo = found.filter(b => !st.browsers.includes(b.id));
  for (const b of found) if (!todo.includes(b)) console.log(`   ✓ ${b.name} already connected`);
  if (!todo.length) return console.log('\nDone. Ask your agent: "use reins to list my tabs".');

  const copied = clipboard(EXT_DIR);
  for (const b of todo) openPage(b.exe, b.page);
  console.log(`   Opened the extensions page in: ${todo.map(b => b.name).join(', ')}. In each one:
   a. Turn on "Developer mode" (a switch at the top right, or bottom left in Edge).
   b. Click "Load unpacked".
   c. ${{ darwin: 'Press Cmd+Shift+G, paste (Cmd+V)', linux: 'Press Ctrl+L, paste (Ctrl+V)' }[process.platform] || 'Paste (Ctrl+V) into the folder box'}${copied ? '' : ' this path'}: ${EXT_DIR}  then press Enter.
${todo.some(b => st.old?.includes(b.id)) ? '   An older "Spark" extension is installed. Click Remove on it first.\n' : ''}
   Waiting for the browsers to connect (Ctrl+C to stop)...`);
  const left = new Set(todo.map(b => b.id));
  for (let i = 0; left.size && i < 600; i++) {
    await sleep(1000);
    st = await request('/status').catch(() => st);
    for (const id of left) if (st.browsers.includes(id)) { left.delete(id); console.log(`   ✓ ${BROWSERS.find(b => b.id === id).name} connected`); }
  }
  console.log(left.size ? `\nStill waiting on: ${[...left].join(', ')}. Run "reins install" again any time.` : '\nDone. Ask your agent: "use reins to list my tabs".');
}

// ---------- review: the user approves or rejects memory that agents saved ----------
async function review() {
  if (!USER) { console.error('reins review asks you to approve each item, so run it yourself in a terminal.'); process.exitCode = 1; return; }
  const items = JSON.parse((await callTool('memory', { action: 'pending' })).text);
  if (!items.length) return console.log('Nothing to review.');
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));
  console.log(`${items.length} item(s) saved by agents. Approved items are shown to every agent on that site; rejected ones are deleted.\n`);
  let done = 0;
  for (const it of items) {
    console.log(`[${it.kind}] ${it.site}  (by ${it.by})\n` + it.text.split('\n').map(l => '  ' + l).join('\n'));
    const a = (await ask('Approve? [y]es / [n]o, delete / [s]kip: ')).trim().toLowerCase();
    if (a === 'y' || a === 'n') {
      await callTool('memory', { action: a === 'y' ? 'approve' : 'reject', kind: it.kind, site: it.site, key: it.key });
      done++;
    }
    console.log();
  }
  rl.close();
  console.log(`Reviewed ${done} of ${items.length}.`);
}

// ---------- CLI ----------
function parseArgs(list) {
  // @file.json: PowerShell 5.1 strips quotes from JSON passed to native programs, so a file is the safe route there.
  if (list.length === 1 && list[0].startsWith('@')) return JSON.parse(fs.readFileSync(list[0].slice(1), 'utf8'));
  if (list.length === 1 && list[0].trim().startsWith('{')) return JSON.parse(list[0]);
  const a = {};
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i < 0) { a[kv] = true; continue; }
    const v = kv.slice(i + 1);
    try { a[kv.slice(0, i)] = JSON.parse(v); } catch { a[kv.slice(0, i)] = v; }
  }
  return a;
}
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'serve') return serve();
  if (cmd === 'mcp') return mcp();
  if (cmd === 'install') return install(parseArgs(rest));
  if (cmd === 'status') return console.log(JSON.stringify(await ensureDaemon()));
  if (cmd === 'review') return review();
  if (cmd === 'reload-extension') return console.log((await callTool('reload', parseArgs(rest))).text);
  const t = TOOLS.find(x => x.name === cmd);
  if (!t) {
    console.log('Usage: reins install [extension=false] | reins <serve|mcp|status|review|reload-extension> | reins <tool> key=value ...  (or one JSON arg)\nTools:\n' +
      TOOLS.map(x => `  ${x.name.padEnd(11)} ${Object.keys(x.inputSchema.properties).filter(k => k !== 'tab' && k !== 'browser').join(' ')}`).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
  try {
    const r = await callTool(cmd, parseArgs(rest));
    if (r.image) {
      const f = path.join(DIR, 'screenshot.jpg');
      fs.writeFileSync(f, Buffer.from(r.image, 'base64'));
      r.text += `\nSaved: ${f}`;
    }
    console.log(r.text);
  } catch (e) { console.error('Error: ' + e.message); process.exitCode = 1; } // process.exit() here trips a libuv assert on Windows
}
main();
