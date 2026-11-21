#!/usr/bin/env node
// Reins: local daemon (bridges agents <-> browser extension), MCP stdio server, and CLI.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const PORT = 17333; // ponytail: fixed port, must match extension/background.js
const EXT_ID = 'ggjpcidlnhbhdjajedgegjcnpnialhco'; // pinned by the "key" in extension/manifest.json
const DIR = path.join(os.homedir(), '.reins');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  let last = null, seq = 0;
  const pick = name => name
    ? browsers.find(b => b.name === name) || browsers.find(b => b.name.startsWith(name))
    : browsers.includes(last) ? last : browsers[0];

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
    const b = pick(msg.browser);
    if (!b) return reply(200, { error: browsers.length
      ? `No browser "${msg.browser}". Connected: ${browsers.map(x => x.name).join(', ')}`
      : 'No browser connected. Open Chrome or Edge with the Reins extension installed (toolbar badge shows ON).' });
    last = b;
    const id = ++seq, ms = (msg.args?.timeout || 0) + 60000;
    reply(200, await new Promise(resolve => {
      const t = setTimeout(() => { b.pending.delete(id); resolve({ error: `Timed out after ${ms / 1000}s` }); }, ms);
      b.pending.set(id, m => { clearTimeout(t); resolve(m); });
      b.ws.send(JSON.stringify({ id, tool: msg.tool, args: msg.args || {} }));
    }));
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
  // A sleeping extension reconnects on its 30s alarm; wait for it instead of failing the first call.
  for (let i = 0; !st.browsers.length && i < 70; i++) { await sleep(500); st = await request('/status'); }
  const t0 = Date.now();
  const r = await request('/call', { tool, args: rest, browser });
  const out = r.error ? { text: 'Error: ' + r.error } : typeof r.result === 'string' ? { text: r.result } : r.result;
  if (process.env.REINS_METER) // per-call usage log for cost tracking of long-running agents
    fs.appendFileSync(process.env.REINS_METER, JSON.stringify({ ts: t0, ms: Date.now() - t0, tool, args: rest, text: out.text, image: !!out.image, imageBytes: out.image?.length }) + '\n');
  if (r.error) throw new Error(r.error);
  return out;
}

// ---------- tool schemas ----------
const ref = { type: 'string', description: 'Element ref from the latest snapshot, e.g. e12 or f1e5' };
const tab = { type: 'number', description: 'Tab id. Default: the agent target tab' };
const browser = { type: 'string', description: 'chrome, edge, ... (only when several browsers are connected)' };
const after = { type: 'boolean', description: 'Default returns a diff of what changed. true = full snapshot, false = nothing' };
const tool = (name, description, properties, required = []) =>
  ({ name, description, inputSchema: { type: 'object', properties: { ...properties, tab, browser }, required } });
const TOOLS = [
  tool('tabs', 'List, open, switch to (focus) or close tabs. The * tab in the list is the agent target.', {
    action: { type: 'string', enum: ['list', 'new', 'switch', 'close'] }, url: { type: 'string' }, background: { type: 'boolean' } }),
  tool('navigate', 'Load a URL (or back/forward/reload) in the target tab and return a snapshot.', {
    url: { type: 'string' }, newTab: { type: 'boolean' }, back: { type: 'boolean' }, forward: { type: 'boolean' }, reload: { type: 'boolean' },
    snapshot: { type: 'boolean', description: 'false to skip the snapshot' }, max: { type: 'number' } }),
  tool('snapshot', 'Compact page outline: text plus [ref] lines for interactive elements, across iframes and shadow DOM. Cheaper than a screenshot.', {
    mode: { type: 'string', enum: ['full', 'interactive', 'text'], description: 'interactive = refs only; text = readable page text' },
    viewport: { type: 'boolean', description: 'Only what is on screen' }, query: { type: 'string', description: 'Only lines containing these words' },
    max: { type: 'number', description: 'Char budget, default 8000' } }),
  tool('click', 'Real mouse click on a ref (scrolls into view, checks nothing covers it) or at x,y of the last screenshot.', {
    ref, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' }, button: { type: 'string', enum: ['left', 'right', 'middle'] },
    force: { type: 'boolean', description: 'Click even if covered' }, snapshot: after }),
  tool('type', 'Type into a field (replaces its content unless clear:false).', {
    ref, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean', description: 'Press Enter after' },
    slowly: { type: 'boolean', description: 'Key-by-key, for widgets that need keystrokes' }, snapshot: after }, ['ref']),
  tool('press', 'Press keys: "Enter", "Escape", "Control+a", "Shift+Tab". Optional ref to focus first.', {
    key: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } }, ref, snapshot: after }),
  tool('select', 'Choose an option in a native <select> by value or visible text.', { ref, value: { type: 'string' }, snapshot: after }, ['ref', 'value']),
  tool('hover', 'Move the mouse over a ref (menus, tooltips).', { ref, snapshot: after }, ['ref']),
  tool('scroll', 'Scroll the page, or the scrollable area under ref. With ref and no direction: scroll ref into view.', {
    ref, direction: { type: 'string', enum: ['down', 'up', 'left', 'right'] }, amount: { type: 'number', description: 'Screens, default 0.8' }, snapshot: after }),
  tool('upload', 'Attach local files via a file input or an upload button ref.', {
    ref, paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths' }, snapshot: after }, ['ref', 'paths']),
  tool('screenshot', 'JPEG of the visible viewport. Use only when layout/visuals matter; snapshot is cheaper.', {
    maxWidth: { type: 'number', description: 'Default 1280' }, quality: { type: 'number', description: '1-100, default 60' } }),
  tool('eval', 'Run JavaScript in the page and return the JSON result. With ref, `el` is that element. Use `return` for multi-statement code.', {
    code: { type: 'string' }, ref, max: { type: 'number' } }, ['code']),
  tool('batch', 'Run several actions in ONE call, e.g. fill a whole form and click Save. Each step is {tool, ...args} for click/type/press/select/hover/scroll/upload/wait/navigate/eval/snapshot. Stops at the first failure. Returns one diff for the whole sequence. Use it whenever you already know the next refs.', {
    steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' } }, required: ['tool'] } }, snapshot: after }, ['steps']),
  tool('wait','Wait until text appears (or is gone) or the URL contains a string; or sleep ms.', {
    text: { type: 'string' }, gone: { type: 'boolean' }, url: { type: 'string' }, ms: { type: 'number' }, timeout: { type: 'number' }, snapshot: after }),
];

// ---------- MCP stdio server ----------
function mcp() {
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

// Each agent: where it lives (to detect it), how to register the MCP server, where its skills go.
const AGENTS = [
  { name: 'Claude Code', home: '.claude', skills: '.claude/skills', add() {
      const cp = require('child_process'), o = { stdio: 'ignore', shell: process.platform === 'win32' && !onPath('claude.exe') }; // npm-installed claude is a .cmd shim
      const q = s => o.shell ? `"${s}"` : s;
      cp.spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'reins'], o);
      const r = cp.spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'reins', '--', q(SERVER.command), q(__filename), 'mcp'], o);
      if (r.status !== 0) throw new Error('`claude` CLI not found on PATH');
    } },
  { name: 'Codex', home: '.codex', skills: '.codex/skills', add() {
      const p = path.join(HOME, '.codex/config.toml');
      const q = s => `'${s}'`; // TOML literal strings: no escaping of Windows backslashes
      const block = `[mcp_servers.reins]\ncommand = ${q(SERVER.command)}\nargs = [${SERVER.args.map(q).join(', ')}]\ntool_timeout_sec = 120\n`;
      const t = exists(p) ? fs.readFileSync(p, 'utf8') : '';
      const re = /^\[mcp_servers\.reins\][\s\S]*?(?=^\[|(?![\s\S]))/m; // up to the next table header at line start
      fs.writeFileSync(p, re.test(t) ? t.replace(re, block + '\n') : t.trimEnd() + '\n\n' + block);
    } },
  { name: 'OpenCode', home: '.config/opencode', skills: '.config/opencode/skills', add() {
      const d = path.join(HOME, '.config/opencode');
      const p = ['opencode.json', 'opencode.jsonc'].map(f => path.join(d, f)).find(exists) || path.join(d, 'opencode.json');
      const j = readJson(p);
      (j.mcp ||= {}).reins = { type: 'local', command: [SERVER.command, ...SERVER.args], enabled: true, timeout: 120000 };
      writeJson(p, j);
    } },
  { name: 'Antigravity', home: '.gemini/config', skills: '.gemini/config/skills', add() {
      const p = path.join(HOME, '.gemini/config/mcp_config.json'), j = readJson(p);
      (j.mcpServers ||= {}).reins = SERVER;
      writeJson(p, j);
    } },
  { name: 'Gemini CLI', home: '.gemini/settings.json', skills: '.gemini/skills', add() {
      const p = path.join(HOME, '.gemini/settings.json'), j = readJson(p);
      (j.mcpServers ||= {}).reins = { ...SERVER, timeout: 120000 };
      writeJson(p, j);
    } },
  { name: 'Cursor', home: '.cursor', skills: null, add() {
      const p = path.join(HOME, '.cursor/mcp.json'), j = readJson(p);
      (j.mcpServers ||= {}).reins = SERVER;
      writeJson(p, j);
    } },
  { name: 'Windsurf', home: '.codeium/windsurf', skills: null, add() {
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
      console.log(`   ✓ ${a.name}${a.skills ? ' (tools + skill)' : ' (tools)'}`);
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
   c. ${copied ? 'Paste (Ctrl+V / Cmd+V) into the folder box' : 'Choose this folder'}: ${EXT_DIR}  then press Enter.
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
  if (cmd === 'reload-extension') return console.log((await callTool('reload', parseArgs(rest))).text);
  const t = TOOLS.find(x => x.name === cmd);
  if (!t) {
    console.log('Usage: reins install [extension=false] | reins <serve|mcp|status|reload-extension> | reins <tool> key=value ...  (or one JSON arg)\nTools:\n' +
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
