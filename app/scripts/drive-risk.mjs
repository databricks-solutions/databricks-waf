// Walks the accepted-risk journey in a real browser, the way a reader walks it.
//
// `drive-labs.mjs` opens every page and asks whether it rendered. This asks whether one journey can be
// completed: find a requirement that failed, accept the exposure, and find it again on the register an
// auditor asks for by name. That is a different question, and the answers to it are not visible from a
// page that rendered — every step below passed its unit tests while the journey was broken in the
// browser, because what breaks a journey is the arrangement of the parts rather than the parts.
//
// Two of the checks here exist because this script found the defect they now guard:
//
//   - the record has to be on screen after it is recorded. A tall form is replaced by a short record,
//     and the browser's scroll correction put what had just been written below the fold, so the reader
//     pressed the button and the pane appeared to lose their work.
//   - no two controls in the pane may share a name. The decision form offered "Accepting the risk"
//     beside the record headed the same words, and they do different things — one parks a finding and
//     the other is what the register is built from.
//
// It writes rather than reads, so point it at an app whose records you are willing to add to. Against
// a deployed app that is a real acceptance on a real requirement, which is the point: nothing else
// establishes that the write path works through the proxy, the routes and the store.
//
//   TOKEN=$(databricks auth token -p labs | jq -r .access_token) \
//   APP=https://<app>.databricksapps.com EMAIL=you@example.com node scripts/drive-risk.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { open, settle } from './browser.mjs';

const origin = (process.env.APP ?? 'http://localhost:8000').replace(/\/$/, '');
const token = process.env.TOKEN ?? '';
if (token === '') {
  console.error('Set TOKEN to a workspace token. APP defaults to http://localhost:8000.');
  process.exit(2);
}

const shots = '.tmp-shots/risk';
mkdirSync(shots, { recursive: true });

const page = await open({ width: 1512, height: 945 });

/*
 * Screenshots are diagnostics, so a failed one is reported and not thrown.
 *
 * The journey's verdict comes from what the checks below read out of the page. Losing a picture makes a
 * failure harder to look at afterwards; letting it end the run loses the verdict as well.
 */
const shot = async (name) => {
  try {
    writeFileSync(`${shots}/${name}.png`, await page.screenshot());
  } catch (cause) {
    console.log(`  (no screenshot for ${name}: ${cause instanceof Error ? cause.message : String(cause)})`);
  }
};

// All three forms, for the reason drive-labs.mjs sends all three: which one is read depends on whether
// the Apps proxy is in front of the app.
await page.send('Network.enable');
await page.send('Network.setExtraHTTPHeaders', {
  headers: {
    Authorization: `Bearer ${token}`,
    'x-forwarded-access-token': token,
    ...(process.env.EMAIL != null && process.env.EMAIL !== '' ? { 'x-forwarded-email': process.env.EMAIL } : {}),
  },
});

const failures = [];
const say = (ok, line) => {
  console.log(`${ok ? '✓' : '✗'} ${line}`);
  if (!ok) failures.push(line);
};

/*
 * The acceptance form, found by a field only it has.
 *
 * Not by its prose. The first draft of this script found the form by the words "holding the line",
 * which then appeared in the decision form beside it — telling a reader that parking a finding is not
 * the register — and the script silently drove the wrong form.
 */
const SCOPED = `
  const form = [...document.querySelectorAll('form')].find((f) => f.querySelector('[id^="risk-control-"]') != null);
  const set = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
`;

const owner = `drive-${String(Date.now()).slice(-6)}@example.com`;
const holding = 'Access is restricted to two named service principals and reviewed at the weekly platform meeting.';

/*
 * 1. A requirement that failed and has no acceptance on it yet.
 *
 * Rows are tried in turn rather than taking the first, because one requirement carries one acceptance at
 * a time and the app correctly offers nothing on a requirement that already has one. Running this script
 * twice used to fail on the second run for that reason, and the failure looked like a broken form.
 */
await page.goto(`${origin}/findings?outcome=unmet`);
await settle(1800);
const rows = await page.evaluate(`document.querySelectorAll('ul.wa-zebra button.wa-row').length`);
if (rows === 0) {
  console.error('Nothing has failed on this app, so the journey cannot be walked. Run a scan first.');
  page.close();
  process.exit(1);
}

let picked = '';
for (let index = 0; index < Math.min(rows, 8); index += 1) {
  const opened = await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('ul.wa-zebra button.wa-row')][${String(index)}];
    if (row == null) return '';
    row.click();
    return row.innerText.split('\\n')[0];
  })()`);
  await settle(1400);
  const offers = await page.evaluate(`(() => {
    return [...document.querySelectorAll('button')].some((b) => /^Accept the risk$/.test(b.innerText.trim()));
  })()`);
  if (offers === true) {
    picked = opened;
    break;
  }
  console.log(`  (${opened.slice(0, 40)} already carries an acceptance, trying the next)`);
}

say(picked !== '', `opened a failing requirement with nothing accepted on it: ${picked.slice(0, 60)}`);
if (picked === '') {
  console.error('\nEvery requirement on the first page already carries an acceptance. Revoke one, or scan again.');
  page.close();
  process.exit(1);
}
await shot('1-finding');

/*
 * 2. No two things a reader can press are called the same thing.
 *
 * Controls only — buttons, submits and the legends over radio groups. Not every label: "Observed" and
 * "Expected" head each piece of evidence and are meant to repeat, and a check that counted those
 * reported a collision on every finding and taught its reader to ignore it.
 */
const named = JSON.parse(await page.evaluate(`(() => {
  const pane = document.querySelector('.wa-task-workspace-main') ?? document.body;
  const labels = [...pane.querySelectorAll('button, legend')]
    .map((n) => n.innerText.trim().toLowerCase())
    .filter((t) => t.length > 3 && t.length < 60);
  const seen = new Map();
  for (const label of labels) seen.set(label, (seen.get(label) ?? 0) + 1);
  return JSON.stringify({ repeated: [...seen].filter(([, n]) => n > 1).map(([t]) => t) });
})()`));
say(
  named.repeated.length === 0,
  named.repeated.length === 0
    ? 'no two controls in the pane are called the same thing'
    : `two controls share a name: ${named.repeated.join(' / ')}`
);

// 3. The form is offered, and asks the two questions.
await page.evaluate(`(() => {
  [...document.querySelectorAll('button')].find((b) => /Accept the risk|Accept again/.test(b.innerText))?.click();
})()`);
await settle(1200);
await shot('2-form');

const form = JSON.parse(await page.evaluate(`(() => {${SCOPED}
  if (form == null) return JSON.stringify({ missing: true, residual: [] });
  const text = form.innerText;
  return JSON.stringify({
    missing: false,
    twoQuestions: /Why the requirement is not met/.test(text) && /What is holding the line instead/.test(text),
    saysScore: /Does not change the score/.test(text),
    saysNoEdit: /Cannot be edited afterwards/.test(text),
    residual: [...form.querySelectorAll('input[type="radio"]')].map((r) => r.value),
    maxExpiry: form.querySelector('input[id^="risk-until"]')?.max ?? '',
    minStart: form.querySelector('input[id^="risk-from"]')?.min ?? '',
    refusesEmpty: form.querySelector('button[type="submit"]')?.disabled === true,
  });
})()`));
say(!form.missing, 'the finding offers to accept the risk');
say(form.twoQuestions === true, 'it asks why, and what is holding the line, as two questions');
say(form.saysScore === true && form.saysNoEdit === true, 'it says the score does not move and there is no edit');
say(form.refusesEmpty === true, 'it refuses to be submitted empty');
say(form.residual.length > 0, `it offers a residual no higher than the requirement: ${form.residual.join(', ')}`);
console.log(`  expiry capped at ${form.maxExpiry}, no start before ${form.minStart}`);

// 4. The words that defeat the compensating-control field are refused by name.
await page.evaluate(`(() => {${SCOPED}
  const areas = [...form.querySelectorAll('textarea')];
  set(areas[0], 'The workspace holds only synthetic data and the fix needs a platform change we have not scheduled yet.');
  set(areas[1], 'n/a');
})()`);
await settle(400);
const refused = JSON.parse(await page.evaluate(`(() => {${SCOPED}
  return JSON.stringify({
    text: form.innerText,
    disabled: form.querySelector('button[type="submit"]').disabled,
  });
})()`));
say(
  /write that as a sentence/i.test(refused.text),
  'it refuses "n/a" by saying what the field is for, not by counting characters'
);
say(refused.disabled === true, 'and will not be submitted while that stands in for a control');
await shot('3-refused');

// 5. Every question answered, then recorded.
await page.evaluate(`(() => {${SCOPED}
  const areas = [...form.querySelectorAll('textarea')];
  set(areas[1], ${JSON.stringify(holding)});
  set(form.querySelector('input[id^="risk-owner"]'), ${JSON.stringify(owner)});
  const radios = [...form.querySelectorAll('input[type="radio"]')];
  radios[radios.length - 1].click();
  form.querySelector('button[type="submit"]').scrollIntoView({ block: 'center' });
})()`);
await settle(500);
await shot('4-filled');

const submitted = await page.evaluate(`(() => {${SCOPED}
  const button = form.querySelector('button[type="submit"]');
  if (button == null || button.disabled) return false;
  button.click();
  return true;
})()`);
say(submitted === true, 'the form became submittable once every question was answered');
await settle(2500);
await shot('5-recorded');

const recorded = JSON.parse(await page.evaluate(`(() => {
  const text = document.body.innerText;
  const line = [...document.querySelectorAll('*')].find(
    (e) => e.children.length === 0 && /still unmet and still costs its points/.test(e.textContent ?? '')
  );
  const box = line?.getBoundingClientRect();
  return JSON.stringify({
    saysUnmet: line != null,
    saysExpiry: /Expires/.test(text),
    namesOwner: text.includes(${JSON.stringify(owner)}),
    // Rendered is not the same as readable: the defect this guards put it below the fold.
    inView: box != null && box.top < window.innerHeight && box.bottom > 0,
  });
})()`));
say(recorded.saysUnmet === true, 'the record says the requirement is still unmet');
say(recorded.inView === true, 'and is on screen once it is recorded, rather than below the fold');
say(recorded.saysExpiry === true, 'the record says when the acceptance ends');
say(recorded.namesOwner === true, 'the record names who is answerable');

// 6. The register.
await page.goto(`${origin}/exceptions`);
await settle(1600);
await shot('6-register');
const register = JSON.parse(await page.evaluate(`(() => {
  const text = document.body.innerText;
  return JSON.stringify({
    rows: document.querySelectorAll('ul.wa-zebra button.wa-row').length,
    namesOwner: text.includes(${JSON.stringify(owner)}),
    saysCarrying: /accepted/i.test(text),
    saysScore: /score/i.test(text),
  });
})()`));
say(register.rows > 0, `the register lists it (${String(register.rows)} row)`);
say(register.namesOwner === true, 'the register names who is answerable');
say(register.saysCarrying === true, 'the register leads with what this estate is carrying');
say(register.saysScore === true, 'and says on the page that none of it moves the score');

// 7. Opening it says what is holding the line, and says each thing once.
await page.evaluate(`document.querySelector('ul.wa-zebra button.wa-row')?.click()`);
await settle(900);
await shot('7-register-detail');
const detail = await page.evaluate(`document.body.innerText`);
say(detail.includes(holding.slice(0, 40)), 'the pane quotes what is holding the line');
say(detail.includes(owner), 'the pane names the owner');

/*
 * Nothing said twice, which is what composing a pane out of modules produces.
 *
 * The register's detail pane rendered the note — which ends with who accepted it — and then added "who
 * accepted it" again two paragraphs later. Neither module was wrong on its own, which is why this is
 * checked on the arrangement rather than in either component's test.
 */
const stutter = JSON.parse(await page.evaluate(`(() => {
  const pane = document.querySelector('.wa-task-workspace-main') ?? document.body;
  const said = new Map();
  for (const line of pane.innerText.split('\\n').map((l) => l.trim()).filter((l) => l.length > 30)) {
    said.set(line, (said.get(line) ?? 0) + 1);
  }
  return JSON.stringify({ twice: [...said].filter(([, n]) => n > 1).map(([l]) => l.slice(0, 60)) });
})()`));
say(
  stutter.twice.length === 0,
  stutter.twice.length === 0
    ? 'and says each thing once'
    : `a sentence appears twice in the pane: ${stutter.twice.join(' / ')}`
);

page.close();

console.log(`\nScreenshots in ${shots}`);
if (failures.length > 0) {
  console.error(`\n${String(failures.length)} step(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('The accepted-risk journey works end to end.');
