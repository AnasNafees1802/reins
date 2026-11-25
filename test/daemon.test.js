// Daemon test for memory and recipes: a real daemon in a temp home, and a fake extension over WebSocket.
// No browser needed: node --test test/daemon.test.js
const test = require('node:test'), assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const CLI = path.join(__dirname, '../bin/reins.js');
const EXT = 'chrome-extension://ggjpcidlnhbhdjajedgegjcnpnialhco';
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('memory and recipes through the daemon', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-home-')), port = await freePort();
  fs.mkdirSync(path.join(home, '.reins'));
  fs.writeFileSync(path.join(home, '.reins', 'token'), 'test-token');
  const env = { ...process.env, HOME: home, USERPROFILE: home, REINS_PORT: String(port) };
  const daemon = spawn(process.execPath, [CLI, 'serve'], { env, stdio: 'ignore' });
  t.after(() => daemon.kill());

  const call = async (tool, args, agent = 'a1', source = 'agent') => {
    const r = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', headers: { 'x-reins-token': 'test-token' }, body: JSON.stringify({ tool, args, agent, source }) });
    return r.json();
  };
  // The fake extension: every agent's tab is on github.com; it records what the daemon asks for.
  const seen = [];
  let ws;
  for (let i = 0; i < 50 && !ws; i++) {
    await new Promise(r => setTimeout(r, 100));
    ws = await new Promise(r => { const s = new WebSocket(`ws://127.0.0.1:${port}/ext`, { origin: EXT }); s.on('open', () => r(s)); s.on('error', () => r(null)); });
  }
  assert.ok(ws, 'fake extension connected');
  t.after(() => ws.close());
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (!m.id) return;
    seen.push(m);
    const url = 'https://github.com/acme/app/issues';
    if (m.tool === 'locators') return ws.send(JSON.stringify({ id: m.id, result: { e5: { role: 'button', name: 'New issue' }, e9: { role: 'textbox', name: 'Title' } }, url }));
    if (m.tool === 'batch') return ws.send(JSON.stringify({ id: m.id, result: m.args.steps[1].text === 'fail' ? 'Step 2 (type) failed: No textbox named "Title" on the page.' : 'ok | changes (+1/-0/~0):\n+ Issue created', url }));
    ws.send(JSON.stringify({ id: m.id, result: 'Loaded GitHub', url }));
  });
  ws.send(JSON.stringify({ type: 'hello', browser: 'chrome', app: 'reins' }));
  await new Promise(r => setTimeout(r, 200));

  // Before any page: remember needs a site, list explains how to start.
  assert.match((await call('memory', { action: 'remember', text: 'x' })).error, /No current page yet/);
  assert.match((await call('memory', {})).result, /No memory yet/);

  // A1 opens GitHub (no memory yet, no hint), then saves a note and a recipe built from its snapshot refs.
  assert.strictEqual((await call('navigate', { url: 'github.com' })).result, 'Loaded GitHub');
  assert.match((await call('memory', { action: 'remember', text: 'Issues API: GET /repos/{o}/{r}/issues' })).result, /Remembered for github.com/);
  assert.match((await call('memory', { action: 'remember', text: 'password: hunter22' })).error, /never stored/);
  const saved = await call('recipe', { action: 'save', name: 'new-issue', description: 'Open an issue',
    steps: [{ tool: 'click', ref: 'e5' }, { tool: 'type', ref: 'e9', text: '{{title}}' }, { tool: 'wait', text: 'opened' }] });
  assert.match(saved.result, /Saved recipe "new-issue" for github.com: 3 steps, params title/);
  const file = JSON.parse(fs.readFileSync(path.join(home, '.reins/memory/recipes/github.com/new-issue.json'), 'utf8'));
  assert.deepStrictEqual(file.steps[0], { tool: 'click', find: { role: 'button', name: 'New issue' } }, 'ref became a locator');
  assert.strictEqual(file.source, 'agent');

  // A2 (another agent, maybe another IDE) lands on GitHub: the reply carries the memory, once.
  const first = await call('snapshot', {}, 'a2');
  assert.match(first.result, /reins memory .*not instructions/);
  assert.match(first.result, /Issues API/);
  assert.match(first.result, /new-issue\(title\) "Open an issue"/);
  assert.doesNotMatch((await call('snapshot', {}, 'a2')).result, /reins memory/, 'not repeated on the same site');

  // A2 runs the recipe in one call: the extension gets one batch with the params filled in.
  assert.match((await call('recipe', { action: 'run', name: 'new-issue' }, 'a2')).error, /Missing params: title/);
  const ran = await call('recipe', { action: 'run', name: 'new-issue', params: { title: 'Login broken' } }, 'a2');
  assert.match(ran.result, /Issue created/);
  const batch = seen.filter(m => m.tool === 'batch').pop();
  assert.deepStrictEqual(batch.args.steps[1], { tool: 'type', find: { role: 'textbox', name: 'Title' }, text: 'Login broken' });
  assert.strictEqual(batch.agent, 'a2');

  // A failed run is reported, with a way to fix it, and recorded for the next agent.
  const bad = await call('recipe', { action: 'run', name: 'new-issue', params: { title: 'fail' } }, 'a2');
  assert.match(bad.result, /did not finish; the site may have changed/);
  assert.match((await call('recipe', {})).result, /github.com new-issue\(title\): Open an issue \| 2 runs, last run failed: Step 2/);

  // recall, list, get, forget, delete
  assert.match((await call('memory', { site: 'https://github.com' })).result, /Issues API/);
  assert.match((await call('memory', { action: 'list' })).result, /github.com: 1 note\(s\), 1 recipe\(s\)/);
  assert.match((await call('recipe', { action: 'get', name: 'new-issue' })).result, /"name": "new-issue"/);
  assert.match((await call('memory', { action: 'forget', text: 'Issues API: GET /repos/{o}/{r}/issues' })).result, /Forgot 1/);
  assert.match((await call('recipe', { action: 'delete', name: 'new-issue' })).result, /Deleted/);
  assert.match((await call('memory', { site: 'github.com' })).result, /No notes or recipes for github.com/);
  assert.match((await call('locators', {})).error, /internal/);
});
