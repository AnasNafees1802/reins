// End-to-end check for network, console and watch against a real connected browser.
// Usage: node test/e2e.js   (needs Chrome or Edge with the Reins extension connected)
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const CLI = path.join(__dirname, '../bin/reins.js');
const env = { ...process.env, REINS_AGENT: 'e2e' };
const reins = (tool, args = {}, agent = 'e2e') => {
  const r = spawnSync(process.execPath, [CLI, tool, JSON.stringify(args)], { env: { ...env, REINS_AGENT: agent }, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  console.log(`$ reins ${tool} ${JSON.stringify(args)}\n${out.trim().split('\n').map(l => '  ' + l).join('\n')}`);
  return out;
};
const fixture = spawn(process.execPath, [path.join(__dirname, 'fixture.js')], { stdio: 'ignore' });

let tab;
try {
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']); // let the fixture bind
  tab = +/Opened new tab (\d+)|Opened tab (\d+)/.exec(reins('tabs', { action: 'new', url: 'http://localhost:8701/app', background: true }))?.slice(1).find(Boolean);
  assert(tab, 'opened a tab');

  // network + console: start capture, reload to catch the page's load-time traffic
  assert.match(reins('console', { action: 'start', tab }), /Capturing console/);
  assert.match(reins('network', { action: 'start', tab, reload: true }), /Recording network/);
  const list = reins('network', { tab });
  assert.match(list, /#(\d+) GET 200 \/api\/items\?page=1/);
  assert.match(list, /GET 404 \/api\/missing/);
  const id = +/#(\d+) GET 200 \/api\/items/.exec(list)[1];

  const got = reins('network', { action: 'get', id, tab });
  assert.match(got, /authorization: •+/i, 'auth header masked');
  assert.doesNotMatch(got, /sekret-token/, 'secret never shown');
  assert.doesNotMatch(got, /nonce-sekret/, 'anti-forgery nonce never shown');
  assert.match(got, /"items"/, 'response body shown');

  const rep = reins('network', { action: 'replay', id, tab, url: 'http://localhost:8701/api/items?page=2' });
  assert.match(rep, /200/);
  assert.match(rep, /"page": ?"2"/, 'replay reused the auth header and hit page 2');

  // cross-origin public API (ACAO "*"): replay must not include credentials or the browser blocks it
  const pub = +/#(\d+) POST 200 http:\/\/localhost:8702\/api\/public/.exec(list)[1];
  assert.match(reins('network', { action: 'replay', id: pub, tab, body: 'q=two' }), /"echo": ?"q=two"/, 'cross-origin replay works');

  const con = reins('console', { tab });
  assert.match(con, /\[error\] boom from app/);
  assert.match(reins('console', { tab }), /No new console messages/, 'console drains');

  // watch: change detection on matching lines
  assert.match(reins('watch', { action: 'add', tab, query: 'Item', every: 2, name: 'items', once: false }), /Watching/);
  // a relative time ticking over is noise, not a change; the new item is
  reins('eval', { tab, code: "const l = document.getElementById('list'); l.firstElementChild.textContent = 'Item one, 2 minutes ago'; l.insertAdjacentHTML('beforeend', '<li>Item two</li>'); return 1" });
  const ev = reins('watch', { action: 'wait', timeout: 20000 });
  assert.match(ev, /"items" fired/);
  assert.match(ev, /\+ Item two/);
  assert.doesNotMatch(ev, /minute/, 'relative-time change is not reported');

  // watch: text appears. Another agent watches the same text: each gets only its own event.
  reins('watch', { action: 'add', tab, text: 'Deploy finished', every: 2, name: 'theirs' }, 'e2e-other');
  assert.doesNotMatch(reins('watch', { action: 'list' }), /theirs/, "another agent's watch is not listed");
  reins('watch', { action: 'add', tab, text: 'Deploy finished', every: 2 });
  reins('eval', { tab, code: "document.body.insertAdjacentHTML('beforeend', '<p>Deploy finished</p>'); return 1" });
  const mineEv = reins('watch', { action: 'wait', timeout: 20000 });
  assert.match(mineEv, /text "Deploy finished" appeared/);
  assert.doesNotMatch(mineEv, /theirs/, "did not receive another agent's event");
  assert.match(reins('watch', { action: 'wait', timeout: 20000 }, 'e2e-other'), /"theirs" fired/, 'other agent still gets its event');

  // watch run: the command gets the event as a file, not on its command line
  const out = path.join(require('os').tmpdir(), `reins-e2e-run-${process.pid}.json`);
  reins('watch', { action: 'add', tab, text: 'Run me', every: 2,
    run: `"${process.execPath}" -e "require('fs').copyFileSync(process.env.REINS_EVENT_FILE, process.argv[1])" "${out}"` });
  reins('eval', { tab, code: "document.body.insertAdjacentHTML('beforeend', '<p>Run me</p>'); return 1" });
  reins('watch', { action: 'wait', timeout: 20000 });
  for (let i = 0; i < 20 && !require('fs').existsSync(out); i++) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},250)']);
  assert.match(require('fs').readFileSync(out, 'utf8'), /Run me/, 'run command received the event file');
  require('fs').unlinkSync(out);

  assert.match(reins('watch', { action: 'list' }), /items/, 'once:false watcher still listed');
  assert.doesNotMatch(reins('watch', { action: 'list' }), /Deploy finished/, 'once watcher removed after firing');
  assert.match(reins('watch', { action: 'remove', name: 'items' }), /Removed 1/);
  // The agent keeps its own tab across an extension reload (reins install does one), never falling back to the user's active tab.
  assert.match(reins('snapshot', { max: 100 }), /^App /m, 'target is the e2e tab');
  reins('reload-extension');
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},4000)']);
  assert.match(reins('snapshot', { max: 100 }), /^App /m, 'target survives an extension reload');

  // Link URLs are left out of snapshots unless asked for (they were a third of the tokens on real sites).
  reins('navigate', { tab, url: 'http://localhost:8701/', snapshot: false });
  assert.doesNotMatch(reins('snapshot', { tab, query: 'Open new tab' }), /→/, 'no hrefs by default');
  assert.match(reins('snapshot', { tab, query: 'Open new tab', hrefs: true }), /→\/two/, 'hrefs:true shows them');

  // Checkboxes named only by nearby text get that text as their name; a label repeated as text is shown once.
  const filters = reins('snapshot', { tab, query: 'checkbox|Add to cart' });
  assert.match(filters, /checkbox "Prime delivery"/, 'unlabelled checkbox named from its wrapper');
  assert.match(filters, /checkbox "4 stars and up"/);
  assert.strictEqual(filters.match(/Add to cart/g).length, 1, 'button label not repeated as a text line');

  // find: act by role and name instead of a ref.
  reins('navigate', { tab, url: 'http://localhost:8701/', snapshot: false });
  reins('type', { tab, find: { role: 'textbox', name: 'Your name' }, text: 'Ada', snapshot: false });
  assert.match(reins('click', { tab, find: { role: 'button', name: 'Go' } }), /clicked Ada/, 'find clicks the right button');
  assert.match(reins('click', { tab, find: { role: 'button', name: 'Nope' } }), /No button named "Nope"/);

  // recipe: save from refs (they become locators), run in one call, only on its own site, then clean up.
  // The CLI here has no terminal, so it counts as an agent: what it saves stays pending, usable only by itself.
  const refOf = (out, re) => new RegExp(`\\[(e\\d+)\\] ${re}`).exec(out)?.[1];
  const page = reins('snapshot', { tab, query: 'Your name|button Go' });
  const steps = [{ tool: 'type', ref: refOf(page, 'textbox "Your name"'), text: '{{who}}' }, { tool: 'click', ref: refOf(page, 'button "Go"') }];
  assert.match(reins('recipe', { action: 'save', name: 'e2e-greet', description: 'e2e test', steps }), /Saved recipe "e2e-greet" for localhost/);
  assert.match(reins('recipe', { action: 'save', name: 'e2e-bad', steps: [{ tool: 'eval', code: '1' }] }), /no eval or upload/);
  assert.match(reins('memory', { action: 'remember', text: 'x', site: '*' }), /Only the user can write memory for every site/);
  reins('navigate', { tab, reload: true, snapshot: false });
  assert.match(reins('recipe', { action: 'run', name: 'e2e-greet', params: { who: 'Grace' } }), /clicked Grace/, 'recipe ran after a reload');
  assert.match(reins('recipe', { action: 'run', name: 'e2e-greet', params: { who: 'x' } }, 'e2e-other'), /No recipe|waits for the user/, 'another agent cannot run a pending recipe');
  assert.match(reins('recipe', { action: 'delete', name: 'e2e-greet' }), /Deleted/);

  console.log('\nE2E OK');
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (tab) reins('tabs', { action: 'close', tab });
  fixture.kill();
}
