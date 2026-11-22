// Benchmark: cost (turns + output tokens), speed (ms) and accuracy on the hard cases in fixture.js /hard and /hung.
// Plays the agent: when a reply does not show what the step needed, it spends a recovery turn like a real agent would.
// The task suite runs twice: on a calm page, and on one that never stops mutating (like ads, carousels, live counters).
// Usage: node test/bench.js   (needs Chrome or Edge with the Reins extension connected)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const CLI = path.join(__dirname, '../bin/reins.js');
const METER = path.join(os.tmpdir(), `reins-bench-${process.pid}.jsonl`);
const env = { ...process.env, REINS_AGENT: 'bench', REINS_METER: METER };
const pause = ms => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
const reins = (tool, args = {}) => {
  const r = spawnSync(process.execPath, [CLI, tool, JSON.stringify({ browser: process.env.BENCH_BROWSER || 'chrome', ...args })], { env, encoding: 'utf8', timeout: 90000 });
  return (r.stdout || '') + (r.stderr || '');
};
const refOf = (out, re) => (out.split('\n').find(l => re.test(l)) || '').match(/\[((?:f\d+)?e\d+)\]/)?.[1];
const fixture = spawn(process.execPath, [path.join(__dirname, 'fixture.js')], { stdio: 'ignore' });
const results = [];
// One task = one or more agent turns. need(out) says whether the reply was enough; if not, recover() runs as an extra turn.
function step(name, run, need, recover) {
  let out = run(), turns = 1;
  if (!need(out) && recover) { out = recover(); turns++; }
  results.push({ name, ok: need(out), turns });
  return out;
}
function tasks(tab, url, tag) {
  let snap = reins('navigate', { tab, url });

  // Debounced search behind a 700ms API: the reply should already contain the results.
  step(`${tag} search fills in`, () => reins('type', { tab, ref: refOf(snap, /Search fruit/), text: 'ap' }), o => /Apricot/.test(o),
    () => reins('wait', { tab, text: 'Apricot' }));
  snap = reins('snapshot', { tab });

  // The list re-renders; the agent clicks a ref it saw before the re-render.
  const apricot = refOf(snap, /button "Apricot"/);
  reins('click', { tab, ref: refOf(snap, /Refresh list/), snapshot: false });
  step(`${tag} stale ref`, () => reins('click', { tab, ref: apricot }), o => /Picked: Apricot/.test(o), () => {
    const s = reins('snapshot', { tab, query: 'Apricot' });
    return reins('click', { tab, ref: refOf(s, /button "Apricot"/) });
  });

  // Custom dropdown: open, then pick from the reply.
  snap = reins('snapshot', { tab });
  const open = reins('click', { tab, ref: refOf(snap, /combobox "Shipping/) });
  step(`${tag} custom dropdown`, () => reins('click', { tab, ref: refOf(open, /option "Express"/) }), o => /Shipping: Express/.test(o));

  // Save, confirm in a dialog, slow server: the confirm reply should show the saved state.
  snap = reins('snapshot', { tab });
  const dlg = reins('click', { tab, ref: refOf(snap, /button "Save"/) });
  step(`${tag} confirm + slow save`, () => reins('click', { tab, ref: refOf(dlg, /button "Confirm"/) }), o => /Saved: Express/.test(o),
    () => reins('wait', { tab, text: 'Saved:' }));
}

let tab;
const lat = {};
try {
  pause(500);
  tab = +/Opened tab (\d+)/.exec(reins('tabs', { action: 'new', url: 'http://localhost:8701/hard?calm', background: true }))[1];
  tasks(tab, 'http://localhost:8701/hard?calm', 'calm ');
  tasks(tab, 'http://localhost:8701/hard', 'churn');

  // A frame that hangs must not hang the page read.
  reins('navigate', { tab, url: 'http://localhost:8701/hung', snapshot: false });
  pause(800);
  step('hung iframe', () => reins('snapshot', { tab }), o => /Still works/.test(o));

  // Raw action latency: 8 clicks on a no-op button, on each page.
  for (const [k, url] of [['calm', 'http://localhost:8701/hard?calm'], ['churn', 'http://localhost:8701/hard']]) {
    const noop = refOf(reins('navigate', { tab, url }), /Refresh list/);
    lat[k] = [];
    for (let i = 0; i < 8; i++) { const t0 = Date.now(); reins('click', { tab, ref: noop }); lat[k].push(Date.now() - t0); }
  }
} catch (e) {
  console.error('BENCH ERROR:', e.message);
  process.exitCode = 1;
} finally {
  if (tab) reins('tabs', { action: 'close', tab });
  fixture.kill();
}

const rows = fs.existsSync(METER) ? fs.readFileSync(METER, 'utf8').trim().split('\n').map(JSON.parse) : [];
fs.rmSync(METER, { force: true });
const tok = s => Math.ceil((s || '').length / 3.5);
const sum = a => a.reduce((x, y) => x + y, 0);
const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(26)} ${r.turns} turn(s)`);
if (results.some(r => !r.ok)) process.exitCode = 1;
console.log(`\naccuracy: ${results.filter(r => r.ok).length}/${results.length} tasks, agent turns on tasks: ${sum(results.map(r => r.turns))} (minimum ${results.length})`);
console.log(`all calls: ${rows.length}, output tokens: ${sum(rows.map(r => tok(r.text)))}, daemon ms: ${sum(rows.map(r => r.ms))}`);
console.log(`click wall time incl. CLI start, median: calm ${med(lat.calm || [0])}ms, churn ${med(lat.churn || [0])}ms`);
const by = {};
for (const r of rows) (by[r.tool] ||= []).push(r.ms);
console.log('median daemon ms by tool:', Object.entries(by).map(([t, v]) => `${t} ${med(v)}`).join(', '));
console.log('slowest calls:', rows.slice().sort((a, b) => b.ms - a.ms).slice(0, 4).map(r => `${r.tool} ${r.ms}ms`).join(', '));
