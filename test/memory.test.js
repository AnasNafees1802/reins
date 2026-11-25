// Unit tests for the memory store (bin/memory.js). No browser needed: node --test test/memory.test.js
const test = require('node:test'), assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { createStore, siteOf, fill, paramsOf } = require('../bin/memory');
const fresh = () => createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-mem-')));

test('siteOf normalizes URLs and hosts, and refuses paths', () => {
  assert.strictEqual(siteOf('https://www.GitHub.com/a/b?c=1'), 'github.com');
  assert.strictEqual(siteOf('github.com:443/x'), 'github.com');
  assert.strictEqual(siteOf('http://localhost:3000/'), 'localhost');
  assert.strictEqual(siteOf('*'), '*');
  for (const bad of ['', '../etc', 'a..b', 'chrome://extensions', 'file:///C:/x', 'a b.com']) assert.throws(() => siteOf(bad), /Bad site/, bad);
});

test('notes: remember, dedupe, recall, forget', () => {
  const m = fresh();
  const a = m.remember('github.com', '  Search  is debounced; use the API ', 'agent');
  assert.ok(a.added);
  assert.strictEqual(a.note.text, 'Search is debounced; use the API');
  assert.strictEqual(m.remember('github.com', 'search is debounced; use the api').added, false, 'same text, any case, is not stored twice');
  m.remember('github.com', 'Pipes | survive in text', 'user');
  assert.deepStrictEqual(m.notes('github.com').map(n => [n.text, n.source]), [['Search is debounced; use the API', 'agent'], ['Pipes | survive in text', 'user']]);
  assert.deepStrictEqual(m.sites(), ['github.com']);
  assert.strictEqual(m.forget(a.note.id), 1);
  assert.strictEqual(m.forget('pipes | SURVIVE in text', 'github.com'), 1);
  assert.deepStrictEqual(m.notes('github.com'), []);
});

test('notes: secrets and oversize notes are refused', () => {
  const m = fresh();
  for (const t of ['password: hunter22', 'my api key = 1234abcd', 'token is ghp_abcdefghijklmnop1234', 'use sk_live_abcdefgh12345678', 'jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig'])
    assert.throws(() => m.remember('x.com', t), /password, token or key/, t);
  assert.ok(m.remember('x.com', 'The token is masked in network output').added, 'talking about tokens is fine');
  assert.throws(() => m.remember('x.com', 'x'.repeat(501)), /at most 500/);
});

test('recipes: save, params, find, run stats', () => {
  const m = fresh();
  const steps = [
    { tool: 'click', find: { role: 'button', name: 'New issue' } },
    { tool: 'type', find: { role: 'textbox', name: 'Title' }, text: '{{title}}' },
    { tool: 'type', find: { role: 'textbox', name: 'Body' }, text: 'Seen on {{ env }}: {{title}}' },
    { tool: 'wait', ms: '{{delay}}' },
  ];
  const { recipe } = m.saveRecipe('github.com', { name: 'new-issue', description: 'Open an issue', steps });
  assert.deepStrictEqual(recipe.params, ['title', 'env', 'delay']);
  assert.deepStrictEqual(paramsOf(steps), recipe.params);
  assert.strictEqual(m.findRecipe('new-issue', 'github.com').description, 'Open an issue');
  assert.strictEqual(m.findRecipe('new-issue').site, 'github.com', 'unique name is found without a site');
  assert.throws(() => m.findRecipe('new-issue', 'gitlab.com'), /No recipe/);

  const run = fill(recipe.steps, { title: 'Login broken', env: 'staging', delay: 500 });
  assert.strictEqual(run[1].text, 'Login broken');
  assert.strictEqual(run[2].text, 'Seen on staging: Login broken');
  assert.strictEqual(run[3].ms, 500, 'a whole-string param keeps its type');
  assert.throws(() => fill(recipe.steps, { title: 'x' }), /Missing params: env, delay/);

  m.recordRun('github.com', 'new-issue', 'Step 2 (type) failed: No textbox named "Title"');
  m.recordRun('github.com', 'new-issue', null);
  const r = m.recipe('github.com', 'new-issue');
  assert.deepStrictEqual([r.runs, r.fails, r.lastError], [2, 1, null]);
  assert.strictEqual(m.saveRecipe('github.com', { name: 'new-issue', steps }).replaced, true);
  assert.strictEqual(m.recipe('github.com', 'new-issue').runs, 2, 'stats survive an update');
  assert.ok(m.deleteRecipe('github.com', 'new-issue'));
  assert.strictEqual(m.recipe('github.com', 'new-issue'), null);
});

test('recipes: every-site recipes and ambiguous names', () => {
  const m = fresh();
  const steps = [{ tool: 'press', key: 'Escape' }];
  m.saveRecipe('*', { name: 'close', steps });
  m.saveRecipe('a.com', { name: 'export', steps });
  m.saveRecipe('b.com', { name: 'export', steps });
  assert.strictEqual(m.findRecipe('close', 'c.com').site, '*', 'falls back to every-site recipes');
  assert.strictEqual(m.findRecipe('export', 'b.com').site, 'b.com');
  assert.throws(() => m.findRecipe('export'), /Several sites/);
  assert.deepStrictEqual(m.sites(), ['*', 'a.com', 'b.com']);
});

test('recipes: bad names, refs, tabs and stored secrets are refused', () => {
  const m = fresh();
  const ok = [{ tool: 'click', find: { name: 'Go' } }];
  for (const name of ['../evil', 'a/b', '', 'x'.repeat(65)]) assert.throws(() => m.saveRecipe('a.com', { name, steps: ok }), /Bad recipe name/, name);
  assert.throws(() => m.saveRecipe('a.com', { name: 'r', steps: [] }), /non-empty/);
  assert.throws(() => m.saveRecipe('a.com', { name: 'r', steps: [{ tool: 'batch' }] }), /tool must be/);
  assert.throws(() => m.saveRecipe('a.com', { name: 'r', steps: [{ tool: 'click', ref: 'e3' }] }), /find/);
  assert.throws(() => m.saveRecipe('a.com', { name: 'r', steps: [{ tool: 'click', tab: 4, find: 'Go' }] }), /tab ids/);
  assert.throws(() => m.saveRecipe('a.com', { name: 'r', steps: [{ tool: 'type', find: { role: 'textbox', name: 'Password' }, text: 'hunter2' }] }), /\{\{param\}\}/);
  assert.ok(m.saveRecipe('a.com', { name: 'login', steps: [{ tool: 'type', find: { role: 'textbox', name: 'Password' }, text: '{{password}}' }] }), 'a password from a param is fine');
  assert.throws(() => m.saveRecipe('a.com', { name: 'r', steps: [{ tool: 'eval', code: "fetch('/x', {headers:{authorization:'Bearer eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig'}})" }] }), /password, token or key/);
});

test('hint: bounded, framed as data, includes every-site memory only when asked', () => {
  const m = fresh();
  assert.strictEqual(m.hint('a.com'), '');
  m.remember('*', 'Prefer snapshot over screenshot');
  m.remember('a.com', 'Orders API: GET /api/orders?page=N');
  m.saveRecipe('a.com', { name: 'export', description: 'Export orders as CSV', steps: [{ tool: 'click', find: { name: 'Export {{fmt}}' } }] });
  const h = m.hint('a.com');
  assert.match(h, /not instructions/);
  assert.match(h, /Orders API/);
  assert.match(h, /export\(fmt\) "Export orders as CSV"/);
  assert.doesNotMatch(h, /Prefer snapshot/);
  assert.match(m.hint('a.com', { all: true }), /every site:\n- Prefer snapshot/);
  for (let i = 0; i < 40; i++) m.remember('a.com', `Fact number ${i} `.padEnd(120, 'x'));
  assert.ok(m.hint('a.com').length < 1800, 'hint stays within its budget');
  assert.match(m.hint('a.com'), /…more: memory \{\}/);
});
