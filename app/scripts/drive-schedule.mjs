// Drives the scheduled-assessment panel on /history and reports what a reader would see.
//
// Kept for the reason `drive-methodology.mjs` is. `check:viewport` proves the page fits and
// `check:a11y` proves it is operable, and neither can answer the questions this panel is for: does the
// badge agree with the paragraph under it, does the next-run sentence name a time in the job's zone
// rather than the browser's, and — the one that matters most — does opening the run history push the
// scan history off the window.
//
// Five of the six states cannot be produced by a real job. A workspace with the bundle deployed has a
// job, so `not-deployed` needs the job hidden; the job carries a cron, so `no-schedule` needs it
// removed; and `unreadable` needs the grant that this row exists to rely on taken away. Those four are
// stubbed at the one response that decides them. The live state is driven for real.
//
//   npm run dev          # in another terminal, with a scan in it
//   node scripts/drive-schedule.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { open, requireScan, settle } from './browser.mjs';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8000';
const SHOTS = process.env.SHOTS ?? '.tmp-shots';

// The Jobs API takes 1.5 to 2.5s, and the panel renders a skeleton until it answers.
const READ = 3200;

async function shoot(page, name) {
  if (process.env.WAF_NO_SHOTS === '1') return;
  try {
    writeFileSync(`${SHOTS}/schedule-${name}.png`, await page.screenshot());
  } catch {
    console.log(`  (no picture of ${name})`);
  }
}

/** What the panel says, and what its presence costs the table under it. */
const STATE = `(() => {
  const flat = (node) => node?.textContent?.trim().replace(/\\s+/g, ' ') ?? null;
  const panel = document.querySelector('[aria-label="Scheduled assessment"]');
  const runs = document.querySelector('[aria-label="Scan history"]');
  const table = runs?.querySelector('table');
  const details = [...(panel?.querySelectorAll('details') ?? [])];
  // The status strip is inside the panel's body, not the header — whose aside is also a flex-wrap, and
  // matching that first is why the first run of this script reported the button's label as the strip.
  const strip = panel?.querySelector(':scope > div > .flex-wrap');
  return {
    there: panel != null,
    height: panel == null ? 0 : Math.round(panel.getBoundingClientRect().height),
    badge: flat(panel?.querySelector('[data-status]')),
    strip: flat(strip),
    paragraph: flat(panel?.querySelector(':scope > div > p.wa-body-compact')),
    failure: flat(panel?.querySelector(':scope > div > div.wa-caption')),
    button: flat(panel?.querySelector('button')),
    tooltip: panel?.querySelector('button')?.getAttribute('title') ?? null,
    summaries: details.map((one) => ({ summary: flat(one.querySelector('summary')), open: one.open })),
    alert: flat(panel?.querySelector('[role="alert"]')),
    // What the panel leaves the table, which is the number the first version got wrong.
    tableHeight: runs == null ? 0 : Math.round(runs.getBoundingClientRect().height),
    tableOverflows: table == null || runs == null ? null : table.scrollWidth > runs.clientWidth + 1,
    documentScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
    over: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  };
})()`;

/** Every row of the table, cell by cell, in the order a reader meets them. */
const RUNS = `(() => {
  const flat = (node) => node?.textContent?.trim().replace(/\\s+/g, ' ') ?? null;
  const body = document.querySelector('[aria-label="Scan history"] tbody');
  return [...(body?.querySelectorAll(':scope > tr') ?? [])].map((row) => ({
    line: [...row.querySelectorAll('td')].map((cell) => flat(cell)).filter((one) => one != null && one !== '').join(' | '),
  }));
})()`;

const PAGER = `document.querySelector('[aria-label="Scan history"] nav')?.textContent?.trim() ?? 'none'`;

const CAVEAT = `document.querySelector('[aria-label="Scan history"] details summary')?.textContent?.trim() ?? 'none'`;

/** Answers `/api/schedule` with a state a real job in this workspace will not produce. */
function stub(page, payload) {
  return page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/api/schedule')) {
          return new Response(${JSON.stringify(JSON.stringify(payload))}, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return real(input, init);
      };
    })()`,
  });
}

function report(at) {
  if (at.there !== true) {
    console.log('  PANEL MISSING');
    return;
  }
  console.log(`  strip         ${at.strip}`);
  console.log(`  paragraph     ${at.paragraph}`);
  if (at.failure != null) console.log(`  failure       ${at.failure}`);
  console.log(`  button        ${at.button ?? 'none — the job cannot be triggered from here'}`);
  if (at.tooltip != null) console.log(`  tooltip       ${at.tooltip}`);
  for (const one of at.summaries) console.log(`  disclosure    ${one.open ? '[open] ' : ''}${one.summary}`);
  if (at.alert != null) console.log(`  alert         ${at.alert}`);
  console.log(`  panel         ${String(at.height)}px, leaving the table ${String(at.tableHeight)}px`);
  console.log(
    `  fit           ${at.documentScrolls === true ? `DOCUMENT SCROLLS by ${String(at.over)}px` : 'fits'}` +
      `${at.tableOverflows === true ? ', TABLE OVERFLOWS' : ''}`
  );
}

const LIVE_FAILING = undefined; // driven for real

const STUBS = [
  [
    'not-deployed',
    { state: 'not-deployed', triggerable: false, runs: [] },
  ],
  [
    'no-schedule',
    { state: 'no-schedule', jobId: '471148922192497', triggerable: true, runs: [] },
  ],
  [
    'paused',
    {
      state: 'paused',
      jobId: '471148922192497',
      triggerable: true,
      cron: '0 0 6 ? * MON',
      timezone: 'UTC',
      cadence: 'Every Monday at 06:00 UTC',
      ranAs: 'operator@example.com',
      runs: [],
    },
  ],
  [
    'unreadable',
    { state: 'unreadable', triggerable: false, runs: [] },
  ],
  [
    'live-working',
    {
      state: 'live',
      jobId: '471148922192497',
      triggerable: true,
      cron: '0 0 6 ? * MON',
      timezone: 'UTC',
      cadence: 'Every Monday at 06:00 UTC',
      dueAt: '2026-08-10T06:00:00.000Z',
      ranAs: 'operator@example.com',
      runs: [
        {
          runId: '887749221069714',
          state: 'succeeded',
          startedAt: '2026-08-06T02:27:51.724Z',
          finishedAt: '2026-08-06T02:36:04.430Z',
          durationMs: 492706,
          trigger: 'schedule',
          url: 'https://example.databricks.com/#job/1/run/887749221069714',
        },
      ],
    },
  ],
];

mkdirSync(SHOTS, { recursive: true });
await requireScan(ORIGIN);
const page = await open({ width: 1512, height: 845 });
const close = page.close;

try {
  await page.goto(`${ORIGIN}/history`);
  await settle(READ);
  console.log('The real job in this workspace');
  const live = await page.evaluate(STATE);
  report(live);
  await shoot(page, 'live');

  // The panel's disclosure, which is the whole of its remaining cost to the table. The run history used
  // to be here too and took the table to 13px; see `RUNS_VIEWS`.
  await page.evaluate(`(() => {
    for (const one of document.querySelectorAll('[aria-label="Scheduled assessment"] details')) one.open = true;
  })()`);
  // Wait for the disclosure and the document below it to settle before reading geometry.
  await settle(900);
  console.log('\nWith the panel’s disclosure open');
  report(await page.evaluate(STATE));
  await shoot(page, 'live-open');

  // The job's runs, which is the view that replaced the disclosure. A bounded, paged table in the same
  // task surface the scans use rather than a second list competing for it.
  await page.evaluate(`(() => {
    const one = [...document.querySelectorAll('.wa-segmented button')].find((b) => b.textContent?.trim() === 'Job runs');
    one?.click();
    return one != null;
  })()`);
  await settle(700);
  console.log('\nThe job-runs view of the table');
  report(await page.evaluate(STATE));
  console.log(`  url           ${await page.evaluate('location.search')}`);
  for (const run of await page.evaluate(RUNS)) console.log(`  row           ${run.line}`);
  console.log(`  pager         ${await page.evaluate(PAGER)}`);
  console.log(`  caveat        ${await page.evaluate(CAVEAT)}`);
  await shoot(page, 'job-runs');

  // Deep-linked rather than clicked, which is what the panel's links do.
  await page.goto(`${ORIGIN}/history?runs=job`);
  await settle(READ);
  console.log('\nDeep-linked to ?runs=job');
  report(await page.evaluate(STATE));
  console.log(`  rows          ${String((await page.evaluate(RUNS)).length)}`);

  // The smallest supported window, where the first version broke the table.
  await page.resize(1280, 800);
  await settle(700);
  console.log('\nThe same at 1280x800');
  report(await page.evaluate(STATE));
  console.log(`  rows          ${String((await page.evaluate(RUNS)).length)}`);
  await shoot(page, 'job-runs-1280');
  await page.resize(1512, 845);
  await settle(400);
  await page.goto(`${ORIGIN}/history`);
  await settle(READ);

  for (const [name, payload] of STUBS) {
    if (payload === LIVE_FAILING) continue;
    // A fresh page per stub: the fetch patch is installed on document creation and is not removable.
    const one = await open({ width: 1512, height: 845 });
    try {
      await stub(one, payload);
      await one.goto(`${ORIGIN}/history`);
      await settle(READ);
      console.log(`\n${name} (stubbed)`);
      report(await one.evaluate(STATE));
      await shoot(one, name);
    } finally {
      await one.close();
    }
  }
} finally {
  await close();
}
