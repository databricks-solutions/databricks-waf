// What the writes page says about the estate, read from a running app against a real workspace.
//
// Written for the question the page exists to get right, and it is not a layout question: whether a shape
// the platform recorded no written figure for is rendered as a shape with nothing wrong. That is the
// flattering absence ADR 0074 is about, and it is a state rather than a number, so this reports each row's
// badge alongside the screenshot.
//
// It also checks the sentences that may not appear at all — a recommendation neither rule can make, and
// any claim about a table, which nothing in the query history names.
//
//   TOKEN=$(databricks auth token -p labs | jq -r .access_token) \
//   APP=http://localhost:8000 node scripts/shot-writes.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { open, settle } from './browser.mjs';

const origin = (process.env.APP ?? '').replace(/\/$/, '');
const token = process.env.TOKEN ?? '';
const into = process.env.INTO ?? 'build/shots';
if (origin === '' || token === '') {
  console.error('Set APP to the running origin and TOKEN to a workspace token.');
  process.exit(2);
}

const READ = `(() => {
  const text = (node) => (node?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const main = document.querySelector('main') ?? document.body;
  return {
    heading: text(main.querySelector('h1, h2')),
    lead: text(main.querySelector('p')),
    rows: Array.from(main.querySelectorAll('li')).map((row) => text(row)).filter((one) => one !== '').slice(0, 12),
    everything: text(main).slice(0, 6000),
  };
})()`;

mkdirSync(into, { recursive: true });
const page = await open({ width: 1512, height: 845 });
try {
  await page.send('Network.enable');
  await page.send('Network.setExtraHTTPHeaders', {
    headers: { Authorization: `Bearer ${token}`, 'x-forwarded-access-token': token },
  });

  await page.goto(`${origin}/writes`);
  // The analysis is fetched after mount, so what renders first is a skeleton and `goto`'s height settle
  // can be satisfied by a list that grows a row at a time.
  await settle(2500);

  const seen = await page.evaluate(READ);
  console.log(`heading: ${seen.heading}`);
  console.log(`lead:    ${seen.lead}\n`);
  for (const row of seen.rows) console.log(`  ${row}`);

  const said = seen.everything;

  console.log('\nstates the page rendered:');
  for (const phrase of ['Worth a look', 'Nothing found', 'Could not judge']) {
    console.log(`  ${said.includes(phrase) ? 'present' : 'absent '}  ${phrase}`);
  }

  // Each of these would be the page saying more than a field under it supports. A rewrite is not a
  // rewrite-that-should-be-a-merge, and 73 writes out of 19,300 statements is not none of them.
  //
  // Only the summary is scanned, and deliberately: the page renders the customer's own statement text,
  // and `CREATE OR REPLACE TABLE` in it is the estate speaking rather than the app. Whether the app's own
  // prose names a table is asserted over the language functions, in `writes-language.test.ts`, where the
  // statement text is not in the way.
  const summary = said.slice(0, said.indexOf('Ordered by what they wrote'));
  console.log('\nsentences that must not appear in the summary:');
  for (const pattern of [/you should/i, /should be a (merge|auto ?loader)/i, /\btables?\b/i, /\b0% of the\b/]) {
    const hit = pattern.exec(summary);
    console.log(`  ${hit == null ? 'absent ' : `PRESENT (${hit[0]})`}  ${String(pattern)}`);
  }

  writeFileSync(`${into}/writes.png`, await page.screenshot());
  writeFileSync(`${into}/writes.txt`, said);
  console.log(`\nWrote ${into}/writes.png`);
} finally {
  await page.close();
}
