// Unit tests for the pure parts of extension/background.js, loaded with a stand-in for the chrome.* API.
// No browser needed: node --test test/extension.test.js
const test = require('node:test'), assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');

// Any chrome.x.y(...) call resolves to {}; any chrome.x.y.addListener is a no-op.
const stub = () => new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : stub(), apply: () => Promise.resolve({}) });
const ctx = vm.createContext({ chrome: stub(), WebSocket: class { send() {} }, navigator: {}, setTimeout, clearTimeout, console, URL, TextDecoder, atob });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), ctx);
const { pickRef, locatorOf } = ctx;

const lines = [
  'Some intro text with a [e1]"Docs" link in it.',
  '[e2] button "Save"',
  '[e3] textbox "Title" required',
  '[e4] textbox "Body"',
  '[e5] button "Save"',
  '[e6] button "Save draft"',
  '[e7] link "Sign in to see \'private\' repositories and much more text that the snapshot cuts off at eighty …"',
  '--- iframe f1 https://pay.example/ ---',
  '[f1e2] button "Pay now"',
  '[e8] checkbox',
];

test('pickRef: role and exact name', () => {
  assert.strictEqual(pickRef(lines, { role: 'textbox', name: 'title' }), 'e3', 'name ignores case');
  assert.strictEqual(pickRef(lines, { role: 'button', name: 'Save draft' }), 'e6', 'exact match beats partial');
  assert.strictEqual(pickRef(lines, { role: 'link', name: 'Docs' }), 'e1', 'links inside sentences');
  assert.strictEqual(pickRef(lines, 'Pay now'), 'f1e2', 'plain string, inside an iframe');
  assert.strictEqual(pickRef(lines, { role: 'checkbox' }), 'e8', 'role alone');
});

test('pickRef: several matches need nth; none returns null', () => {
  assert.throws(() => pickRef(lines, { role: 'button', name: 'Save' }), /2 matches for button "Save".*Add nth/);
  assert.strictEqual(pickRef(lines, { role: 'button', name: 'Save', nth: 2 }), 'e5');
  assert.throws(() => pickRef(lines, { role: 'button', name: 'Save', nth: 3 }), /Only 2/);
  assert.strictEqual(pickRef(lines, { role: 'button', name: 'Delete' }), null);
  assert.throws(() => pickRef(lines, {}), /needs a name/);
});

test('pickRef: partial and truncated names', () => {
  assert.strictEqual(pickRef(lines, { role: 'textbox', name: 'Bod' }), 'e4');
  const long = 'Sign in to see "private" repositories and much more text that the snapshot cuts off at eighty characters';
  assert.strictEqual(pickRef(lines, { role: 'link', name: long }), 'e7', 'quotes and the 80-char cut are handled');
});

test('locatorOf: the inverse of pickRef, with nth for duplicates', () => {
  assert.deepStrictEqual({ ...locatorOf(lines, 'e3') }, { role: 'textbox', name: 'Title' });
  assert.deepStrictEqual({ ...locatorOf(lines, 'e5') }, { role: 'button', name: 'Save', nth: 2 });
  assert.strictEqual(locatorOf(lines, 'e99'), null);
  for (const ref of ['e1', 'e2', 'e3', 'e5', 'e6', 'f1e2']) assert.strictEqual(pickRef(lines, locatorOf(lines, ref)), ref, ref);
});
