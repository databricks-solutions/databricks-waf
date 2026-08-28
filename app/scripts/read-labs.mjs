// Prints what a reader actually sees on the deployed app, as text.
//
// The sweep in `drive-labs.mjs` answers whether a page rendered. This answers what it said, which is a
// different question and the one that finds the defects a tick cannot: a heading that repeats the panel
// below it, a number with no unit, an empty state on a page that should have content, a sentence that
// reads as a refusal to somebody who is not the person who wrote it.
//
// It exists because screenshot capture on this machine is intermittent (see `browser.mjs`), and a
// review of the surface cannot be blocked on Chrome answering a capture. Text is what the prose
// decisions in this app are made of anyway.
//
//   TOKEN=$(databricks auth token -p labs | jq -r .access_token) \
//   APP=https://<app>.databricksapps.com node scripts/read-labs.mjs /findings /pillars

import { open, settle } from './browser.mjs';

const origin = (process.env.APP ?? '').replace(/\/$/, '');
const token = process.env.TOKEN ?? '';
if (origin === '' || token === '') {
  console.error('Set APP to the deployed origin and TOKEN to a workspace token.');
  process.exit(2);
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('Pass one or more paths, e.g. / /findings /report');
  process.exit(2);
}

const page = await open({ width: 1512, height: 945 });
await page.send('Network.enable');
await page.send('Network.setExtraHTTPHeaders', {
  headers: {
    Authorization: `Bearer ${token}`,
    'x-forwarded-access-token': token,
    ...(process.env.EMAIL != null && process.env.EMAIL !== '' ? { 'x-forwarded-email': process.env.EMAIL } : {}),
  },
});

for (const path of paths) {
  await page.goto(`${origin}${path}`);
  await settle(Number(process.env.WAIT ?? 900));

  const text = await page.evaluate(`(() => document.body.innerText)()`);
  console.log(`\n${'='.repeat(90)}\n${path}\n${'='.repeat(90)}\n${text}`);
}

page.close();
