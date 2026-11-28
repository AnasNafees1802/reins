// End-to-end checks for the form-filling problems found on a real profile site (Naukri).
// Usage: node test/forms.js   (needs Chrome or Edge with the Reins extension from this repo connected)
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const CLI = path.join(__dirname, '../bin/reins.js');
const reins = (tool, args = {}, agent = 'forms') => {
  const r = spawnSync(process.execPath, [CLI, tool, JSON.stringify(args)], { env: { ...process.env, REINS_AGENT: agent }, encoding: 'utf8' });
  return (r.stdout || '') + (r.stderr || '');
};
const refOf = (out, re) => new RegExp(`\\[((?:f\\d+)?e\\d+)\\] ${re}`).exec(out)?.[1];
const fixture = spawn(process.execPath, [path.join(__dirname, 'fixture.js')], { stdio: 'ignore' });
const URL = 'http://localhost:8701/forms';

let tab, failed = 0;
const check = (name, fn) => {
  try { reins('navigate', { tab, url: URL, snapshot: false }); fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); }
};
const openDialog = () => reins('click', { tab, find: { role: 'button', name: 'Edit education' } });

try {
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
  tab = +/Opened tab (\d+)/.exec(reins('tabs', { action: 'new', url: URL, background: true }))?.[1];
  assert(tab, 'opened a tab');

  check('type says when the field kept only part of the text', () => {
    const out = reins('type', { tab, find: { role: 'textbox', name: 'Skills' }, text: 'Clean Architecture' });
    assert.match(out, /holds "Clean "/, out);
    assert.match(out, /maxlength=6/, out);
  });

  check('type stays quiet when the field holds exactly what was typed', () => {
    const out = reins('type', { tab, find: { role: 'textbox', name: 'Course' }, text: 'MCA', snapshot: false });
    assert.doesNotMatch(out, /holds/, out);
  });

  check('type reports a field that reformats the value', () => {
    const out = reins('type', { tab, find: { role: 'textbox', name: 'Salary' }, text: '1000000' });
    assert.match(out, /holds "10,00,000"/, out);
  });

  check('click selects a radio whose input sits under a decoration', () => {
    openDialog();
    const out = reins('click', { tab, find: { role: 'radio', name: 'Distance' } });
    assert.match(reins('snapshot', { tab, query: 'radio' }), /radio "Distance" checked/, out);
  });

  check('click toggles a hidden checkbox', () => {
    const out = reins('click', { tab, find: { role: 'checkbox', name: 'Remote only' } });
    assert.match(reins('snapshot', { tab, query: 'checkbox' }), /checkbox "Remote only" checked/, out);
  });

  check('a checkbox or radio hidden behind its label is listed and clickable', () => {
    const list = reins('snapshot', { tab, query: 'checkbox|radio' });
    assert.match(list, /checkbox "AWS"/, list);
    assert.match(list, /radio "Day shift"/, list);
    const out = reins('click', { tab, find: { role: 'checkbox', name: 'AWS' } });
    assert.match(out, /checkbox "AWS" checked/, out);
    assert.doesNotMatch(reins('snapshot', { tab, query: 'Azure' }), /checked/, 'the other box is untouched');
    assert.match(reins('click', { tab, find: { role: 'radio', name: 'Day shift' } }), /radio "Day shift" checked/);
  });

  check('the reply says when a dialog closed, even after a stale-ref failure', () => {
    openDialog();
    const course = refOf(reins('snapshot', { tab, query: 'Course' }), 'textbox "Course"');
    const out = reins('batch', { tab, steps: [{ tool: 'press', key: 'Escape' }, { tool: 'scroll', ref: course }] });
    assert.match(out, /Dialog closed: "Education"/, out);
  });

  check('click scrolls an option into view inside a scrolling list', () => {
    openDialog();
    reins('click', { tab, find: { role: 'textbox', name: 'Ending year' } });
    const opt = refOf(reins('snapshot', { tab, query: 'link 2020' }), 'link "2020"');
    const out = reins('click', { tab, ref: opt });
    assert.doesNotMatch(out, /Cannot click/, out);
    assert.match(reins('snapshot', { tab, query: 'Ending year' }), /value="2020"/);
  });

  check('choose opens a custom dropdown and picks the option in one call', () => {
    openDialog();
    const out = reins('choose', { tab, find: { role: 'textbox', name: 'Ending year' }, option: '2026' });
    assert.match(out, /value="2026"/, out);
  });

  check('choose says which options exist when none matches', () => {
    openDialog();
    const out = reins('choose', { tab, find: { role: 'textbox', name: 'Ending year' }, option: '1999' });
    assert.match(out, /No option "1999".*2033/s, out);
  });

  check('an open modal scopes the snapshot to the modal and its popups', () => {
    openDialog();
    const out = reins('snapshot', { tab, mode: 'interactive' });
    assert.doesNotMatch(out, /Background action/, out);
    assert.match(out, /textbox "Course"/, out);
    assert.match(out, /all:true/, 'says how to see the page behind');
    assert.match(reins('snapshot', { tab, mode: 'interactive', all: true }), /Background action/);
    reins('click', { tab, find: { role: 'textbox', name: 'Ending year' } });
    assert.match(reins('snapshot', { tab, query: 'link 2030' }), /link "2030"/, 'a portal popup opened from the modal is still shown');
  });

  check('text mode leaves out script source the page renders', () => {
    const out = reins('snapshot', { tab, mode: 'text' });
    assert.match(out, /Forms/, out);
    assert.doesNotMatch(out, /var leaked/, out);
  });

  check('tabs use sets the target tab without bringing it to the front', () => {
    const two = +/Opened tab (\d+)/.exec(reins('tabs', { action: 'new', url: 'http://localhost:8701/two', background: true }))?.[1];
    try {
      assert.match(reins('snapshot', { max: 200 }), /^Two \|/m, 'new tab became the target');
      const out = reins('tabs', { action: 'use', tab });
      assert.match(out, new RegExp(`Target tab is now ${tab}`), out);
      assert.match(reins('snapshot', { max: 200 }), /^Forms \|/m);
      const list = reins('tabs', {});
      assert.doesNotMatch(list, new RegExp(`${tab} \\(active\\)`), 'tab stayed in the background\n' + list);
      assert.match(reins('tabs', { action: 'use', tab: two }, 'forms-other'), /Target tab is now/, 'a free tab can be used by another agent');
      assert.match(reins('tabs', { action: 'use', tab }, 'forms-other'), /in use by another agent/, "another agent's tab is refused");
    } finally { reins('tabs', { action: 'close', tab: two }, 'forms-other'); }
  });
} catch (e) {
  failed++;
  console.error('setup failed:', e.message);
} finally {
  if (tab) reins('tabs', { action: 'close', tab });
  fixture.kill();
  console.log(failed ? `\n${failed} FAILED` : '\nFORMS OK');
  process.exitCode = failed ? 1 : 0;
}
