// Prices a Reins run from test/meter.jsonl as an agent loop with prompt caching.
// Usage: node test/cost.js [meter.jsonl]
const fs = require('fs');
const rows = fs.readFileSync(process.argv[2] || 'D:/Reins/test/meter.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const tok = s => Math.ceil((s || '').length / 3.5); // ponytail: char estimate, swap for count_tokens when an API key is around
const BASE = 4000;      // lean agent: system prompt + Reins skill + 13 tool schemas
const OUT_PER_TURN = 150; // tool call JSON + short reasoning, low/medium effort
const ARGS = r => tok(JSON.stringify(r.args)) + 20;
const MODELS = { 'Opus 5.5': [4, 20, 0.2], 'Sonnet 5.5': [2, 10, 0.1], 'Haiku 5.5': [0.1, 0.5, 0.01] };

function price(results, [inP, outP, readP]) {
  let ctx = BASE, cost = BASE * inP * 1.25 / 1e6, totalIn = 0;
  for (const r of results) {
    const add = r + OUT_PER_TURN;
    cost += ctx * readP / 1e6 + add * inP * 1.25 / 1e6 + OUT_PER_TURN * outP / 1e6; // read cached prefix, write new turn, generate
    totalIn += ctx; ctx += add;
  }
  return { cost, ctx, totalIn };
}
const reins = rows.map(r => tok(r.text) + ARGS(r));
const sum = a => a.reduce((x, y) => x + y, 0);
console.log(`calls: ${rows.length}, errors: ${rows.filter(r => r.text?.startsWith('Error')).length}, wall time: ${(sum(rows.map(r => r.ms)) / 1000).toFixed(0)}s`);
console.log(`Reins tool output: ${sum(reins)} tokens total, avg ${Math.round(sum(reins) / rows.length)}/call, max ${Math.max(...reins)}`);
const byTool = {};
for (const [i, r] of rows.entries()) (byTool[r.tool] ||= [0, 0]), byTool[r.tool][0]++, byTool[r.tool][1] += reins[i];
console.log('by tool:', Object.entries(byTool).map(([t, [n, k]]) => `${t} ${n}x/${k}t`).join(', '));

// Baselines on the same number of turns, measured on these pages:
const SHOT = Math.round(1280 * 544 / 750) + 40; // screenshot after every action (computer-use style)
const FULL = Math.round(2400 / 3.5) + 30;        // full page snapshot after every action (Playwright-MCP style), measured 2.1-2.4k chars here
const HTML = Math.round(305412 / 3.5);           // raw DOM dump per step (naive)
// With batch: calls I issued back-to-back (gap < 3s, no model turn between them) become one call.
const grouped = [];
rows.forEach((r, i) => {
  const prev = rows[i - 1];
  if (prev && r.ts - (prev.ts + prev.ms) < 3000) grouped[grouped.length - 1] += reins[i];
  else grouped.push(reins[i]);
});
console.log(`with batch: ${grouped.length} turns instead of ${rows.length}`);
const runs = { 'Reins + batch': grouped, 'Reins (this run)': reins, 'Full snapshot every step': rows.map(() => FULL), 'Screenshot every step': rows.map(() => SHOT) };
for (const [m, p] of Object.entries(MODELS)) {
  console.log(`\n${m}`);
  for (const [name, res] of Object.entries(runs)) {
    const { cost, ctx } = price(res, p);
    console.log(`  ${name.padEnd(26)} $${cost.toFixed(4)}  (final context ${ctx} tokens)`);
  }
  console.log(`  ${'Raw HTML every step'.padEnd(26)} context overflows 1M after ${Math.floor(1e6 / HTML)} steps`);
}
