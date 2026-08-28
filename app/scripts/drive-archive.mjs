// Walks closing an assessment and opening it again, in a real browser.
//
// Archive was reachable in one press from a list of assessments whose names differ by a word, and had
// no way back: the only recovery was to define a new assessment, which loses the version history and
// the runs stamped against it. Both halves of that are UI arrangement rather than logic, so both are
// checked here rather than in a unit test — the domain function and the route passed their tests
// throughout, and what was wrong was that the button did the thing immediately and nothing undid it.
//
// Three of the checks below exist because this script found what they now guard:
//
//   - the first press must not archive. It has to name the assessment, because the mis-click to
//     protect against is archiving the wrong row rather than not meaning to archive at all.
//   - backing out has to leave the row alone. An early draft cleared the confirmation and archived
//     anyway, which looked identical on screen until the list reloaded.
//   - an archived row must offer the way back and nothing else. Check and Revise stayed on screen
//     while the server refused both, so the page offered work it knew would fail.
//
// It writes, so point it at an app whose assessments you are willing to add to. It archives only the
// assessment it defines itself, and puts it back before it finishes.
//
//   TOKEN=$(databricks auth token -p labs | jq -r .access_token) \
//   APP=https://<app>.databricksapps.com EMAIL=you@example.com node scripts/drive-archive.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { open, settle } from './browser.mjs';

const origin = (process.env.APP ?? 'http://localhost:8000').replace(/\/$/, '');
const token = process.env.TOKEN ?? '';
if (token === '') {
  console.error('Set TOKEN to a workspace token. APP defaults to http://localhost:8000.');
  process.exit(2);
}

const shots = '.tmp-shots/archive';
mkdirSync(shots, { recursive: true });

const page = await open({ width: 1512, height: 945 });

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
 * The row this script drives, found by the name it gave the assessment.
 *
 * Not the first row on the page. The list is whatever the app already holds, and an early draft that
 * took the first row archived somebody else's assessment on a deployed app — which is exactly the
 * mis-click the confirmation this script is here to check was added to prevent.
 */
const ROW = (name) => `
  const row = [...document.querySelectorAll('.wa-row')].find((r) => r.innerText.includes(${JSON.stringify(name)}));
  const press = (label) => {
    const button = [...(row?.querySelectorAll('button, a') ?? [])].find((b) => b.innerText.trim() === label);
    if (button == null) return false;
    button.click();
    return true;
  };
`;

// 1. An assessment to close. Defined through the app's own API from the page, so the request carries
//    the same headers every other request on the page does.
const name = `Drive archive ${String(Date.now()).slice(-6)}`;
await page.goto(`${origin}/definitions`);
await settle(1200);

const defined = JSON.parse(
  await page.evaluate(`(async () => {
    const response = await fetch('/api/definitions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
        attribution: { name: ${JSON.stringify(name)}, owners: ['drive@example.com'], purpose: 'Driving the archive journey.' },
      }),
    });
    const body = await response.text();
    let id = '';
    try {
      id = JSON.parse(body).id ?? '';
    } catch {
      id = '';
    }
    return JSON.stringify({ status: response.status, id, body: body.slice(0, 300) });
  })()`)
);
say(defined.status === 201, `defined an assessment to close (${String(defined.status)})`);
if (defined.status !== 201) {
  console.error(`\nCould not define an assessment: ${defined.body}`);
  page.close();
  process.exit(1);
}
const id = defined.id;

await page.goto(`${origin}/definitions`);
await settle(1600);
await shot('1-open');

const offered = JSON.parse(await page.evaluate(`(() => {${ROW(name)}
  const pager = [...document.querySelectorAll('nav[aria-label$="pagination"] *')].find((e) =>
    /^\\d+ ?\\/ ?\\d+$/.test(e.innerText?.trim() ?? '')
  );
  return JSON.stringify({
    listed: row != null,
    page: pager?.innerText.trim() ?? 'not paged',
    actions: [...(row?.querySelectorAll('button, a') ?? [])].map((b) => b.innerText.trim()),
  });
})()`));
/*
 * On the first page, which the list being newest-first is what makes true.
 *
 * Named as a dependency rather than left as luck. The list pages since 2026-08-05, and an install
 * with a dozen assessments would put a newly defined one out of reach of every check below if the
 * order ever changed — which would report here as "the assessment is listed" failing, sending a
 * reader to look for a broken list rather than a changed sort.
 */
say(offered.listed === true, `the assessment is listed on the first page (${offered.page})`);
say(
  offered.actions.includes('Archive') && offered.actions.includes('Revise'),
  `an open assessment offers the three actions: ${offered.actions.join(', ')}`
);

// 2. The first press asks rather than archives, and names the row.
await page.evaluate(`(() => {${ROW(name)} press('Archive'); })()`);
await settle(700);
await shot('2-asked');

const asked = JSON.parse(await page.evaluate(`(() => {${ROW(name)}
  const text = row?.innerText ?? '';
  return JSON.stringify({
    notice: row?.querySelector('.wa-notice-warning') != null,
    namesIt: (text.match(new RegExp(${JSON.stringify(name)}, 'g')) ?? []).length > 1,
    saysReversible: /put it back/i.test(text),
    saysNothingDeleted: /Nothing is deleted/.test(text),
    warnsAboutTrend: /trend/i.test(text),
    offersOut: [...(row?.querySelectorAll('button') ?? [])].some((b) => b.innerText.trim() === 'Leave it open'),
    stillOpen: !/^Archived$/m.test(text),
  });
})()`));
say(asked.notice === true, 'the first press asks instead of archiving');
say(asked.namesIt === true, 'and names the assessment, which is what tells a reader they had the wrong row');
say(asked.stillOpen === true, 'nothing was archived by asking');
say(asked.saysReversible === true && asked.saysNothingDeleted === true, 'it says nothing is deleted and it can be put back');
say(asked.warnsAboutTrend === true, 'and says what pressing it does stop — a programme built on its runs');
say(asked.offersOut === true, 'it offers a way out of the question');

// 3. Backing out leaves the assessment open. Read after a reload, because the defect this guards
//    cleared the notice and archived anyway, which is invisible until the list is read again.
await page.evaluate(`(() => {${ROW(name)} press('Leave it open'); })()`);
await settle(500);
await page.goto(`${origin}/definitions`);
await settle(1500);
const backedOut = JSON.parse(await page.evaluate(`(() => {${ROW(name)}
  return JSON.stringify({ archived: /^Archived$/m.test(row?.innerText ?? ''), asking: row?.querySelector('.wa-notice-warning') != null });
})()`));
say(backedOut.archived === false, 'backing out left the assessment open');
say(backedOut.asking === false, 'and put the question away');

// 4. Confirming archives it, and the row changes to say so.
await page.evaluate(`(() => {${ROW(name)} press('Archive'); })()`);
await settle(600);
await page.evaluate(`(() => {${ROW(name)} press('Archive it'); })()`);
await settle(2200);
await shot('3-archived');

const archived = JSON.parse(await page.evaluate(`(() => {${ROW(name)}
  const actions = [...(row?.querySelectorAll('button, a') ?? [])].map((b) => b.innerText.trim());
  return JSON.stringify({
    saysArchived: /^Archived$/m.test(row?.innerText ?? ''),
    actions,
    onlyWayBack: actions.length === 1 && /Put it back/.test(actions[0] ?? ''),
  });
})()`));
say(archived.saysArchived === true, 'the row says it is archived');
say(archived.onlyWayBack === true, `and offers the way back and nothing else: ${archived.actions.join(', ')}`);

/*
 * 5. A run against it is refused, and the refusal says where the way back is.
 *
 * Refused before any work starts, so this costs nothing on the warehouse. The other half — that the
 * gate opens again once it is put back — is in `routes.test.ts` rather than here, because proving it
 * in a browser means running a real scan against the estate to establish something already covered.
 *
 * The refusal used to tell a reader to define a new assessment, which loses the version history and
 * the runs stamped against it. It is worth checking by its words rather than its status for that
 * reason: a 400 was correct throughout, and the advice in it was what was wrong.
 */
const refused = JSON.parse(
  await page.evaluate(`(async () => {
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definitionId: ${JSON.stringify(id)} }),
    });
    return JSON.stringify({ status: response.status, body: (await response.text()).slice(0, 400) });
  })()`)
);
say(refused.status === 400, `a run against it is refused (${String(refused.status)})`);
say(/put it back/i.test(refused.body), 'and the refusal points at the way back rather than at defining a new one');

// 6. Putting it back reopens it.
await page.evaluate(`(() => {${ROW(name)} press('Put it back'); })()`);
await settle(2200);
await page.goto(`${origin}/definitions`);
await settle(1500);
await shot('4-reopened');

const reopened = JSON.parse(await page.evaluate(`(() => {${ROW(name)}
  const actions = [...(row?.querySelectorAll('button, a') ?? [])].map((b) => b.innerText.trim());
  return JSON.stringify({ saysArchived: /^Archived$/m.test(row?.innerText ?? ''), actions });
})()`));
say(reopened.saysArchived === false, 'putting it back reopened it');
say(reopened.actions.includes('Archive'), `and the three actions came back: ${reopened.actions.join(', ')}`);

/*
 * 7. Both halves are in the record, and as different actions.
 *
 * One action for both would leave the log saying an assessment was archived twice where it was closed
 * and reopened, and the question the log is read to answer is which of those happened.
 */
const logged = JSON.parse(
  await page.evaluate(`(async () => {
    const response = await fetch('/api/audit?limit=50');
    const body = await response.json();
    const mine = (body.events ?? []).filter((e) => e.target?.id === ${JSON.stringify(id)});
    return JSON.stringify({ actions: mine.map((e) => e.action) });
  })()`)
);
say(
  logged.actions.includes('definition.archive') && logged.actions.includes('definition.unarchive'),
  `the record has both halves as separate actions: ${[...new Set(logged.actions)].join(', ')}`
);

page.close();

console.log(`\nScreenshots in ${shots}`);
if (failures.length > 0) {
  console.error(`\n${String(failures.length)} step(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Closing an assessment and opening it again works end to end.');
