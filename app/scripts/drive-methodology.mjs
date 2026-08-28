// Drives the public Methodology page and reports what a reader would see.
//
// Kept beside the page because its important states are not URL checks. The viewport and accessibility
// sweeps prove that the route fits and is operable; this drive proves that the normal surface contains
// one public Version 1 candidate or release, that development revisions stay inside technical
// provenance, and that an old run is never relabelled as Version 1.
//
//   npm run dev          # in another terminal, with a scan in it
//   node scripts/drive-methodology.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { open, requireScan, settle } from './browser.mjs';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8000';
const SHOTS = '.tmp-shots';

async function shoot(page, name) {
  if (process.env.WAF_NO_SHOTS === '1') return;
  try {
    writeFileSync(`${SHOTS}/${name}.png`, await page.screenshot());
  } catch {
    console.log(`  (no picture of ${name})`);
  }
}

/** What the page says, as facts rather than as a picture. */
const STATE = `(() => {
  const text = (selector) => document.querySelector(selector)?.textContent?.trim().replace(/\\s+/g, ' ') ?? null;
  const rows = [...document.querySelectorAll('[aria-label="Requirements"] ul.wa-zebra > li')];
  const release = document.querySelector('[aria-label="Methodology Version 1"]');
  const technical = document.querySelector('[aria-label="Pre-release technical history"] details');
  return {
    surfaces: [...document.querySelectorAll('section.wa-customer-surface')].map((one) => one.getAttribute('aria-label')),
    release: release?.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 900) ?? null,
    standing: [...(release?.querySelectorAll('p.wa-caption') ?? [])].map((one) =>
      one.textContent?.trim().replace(/\\s+/g, ' ')
    ),
    publicReleasePanels: document.querySelectorAll('[aria-label^="Methodology Version"]').length,
    legacyReleaseSelector: document.querySelector('[aria-label="Releases"]') != null,
    technicalSummary: technical?.querySelector('summary')?.textContent?.trim().replace(/\\s+/g, ' ') ?? null,
    technicalOpen: technical?.open === true,
    technicalText: technical?.open === true
      ? technical.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 1200) ?? null
      : null,
    count: text('[aria-label="Requirements"] header .wa-caption'),
    shown: rows.length,
    first: rows[0]?.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 200) ?? null,
    pager: text('[aria-label="Requirements"] nav'),
    drift: text('.wa-notice-warning'),
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    past: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  };
})()`;

/** Make the latest scan a record from before the public methodology identity existed. */
function developmentRun(page) {
  return page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch;
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const answer = await real(input, init);
        if (!url.includes('/api/scans/latest') || !answer.ok) return answer;
        const scan = await answer.json();
        const { publicMethodology: _development, ...technicalStamp } = scan.stamp;
        return new Response(
          JSON.stringify({ ...scan, stamp: { ...technicalStamp, catalogueVersion: scan.stamp.catalogueVersion } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };
    })()`,
  });
}

mkdirSync(SHOTS, { recursive: true });
await requireScan(ORIGIN);
const page = await open({ width: 1512, height: 845 });
const close = page.close;

try {
  await page.goto(`${ORIGIN}/methodology`);
  await settle(900);
  const at = await page.evaluate(STATE);
  console.log('At rest');
  console.log(`  surfaces        ${JSON.stringify(at.surfaces)}`);
  console.log(`  public releases ${String(at.publicReleasePanels)}`);
  console.log(`  old selector    ${at.legacyReleaseSelector === true ? 'YES — development revisions are releases' : 'no'}`);
  for (const line of at.standing) console.log(`  caption         ${line}`);
  console.log(`  count           ${at.count}`);
  console.log(`  rows shown      ${String(at.shown)}`);
  console.log(`  first row       ${at.first}`);
  console.log(`  pager           ${at.pager}`);
  console.log(`  drift notice    ${at.drift ?? 'none, which is the ordinary case'}`);
  console.log(`  technical       ${at.technicalSummary}`);
  console.log(`  folded          ${at.technicalOpen === true ? 'NO' : 'yes'}`);
  console.log(`  overflow        ${at.overflow === true ? 'YES — the page is wider than the window' : 'no'}`);
  await shoot(page, 'methodology');

  // The weighting is the half of the methodology a requirement list cannot show. It remains open on
  // a reference page rather than hidden behind a disclosure.
  const weights = await page.evaluate(`(() => {
    const panel = document.querySelector('[aria-label="How a score is computed"]');
    return panel?.textContent?.trim().replace(/\\s+/g, ' ') ?? null;
  })()`);
  console.log('\nHow a score is computed');
  console.log(`  ${weights == null ? 'PANEL MISSING' : weights.slice(0, 700)}`);

  // Development revisions are support provenance: reachable, folded on arrival and never buttons in
  // the customer release model.
  const opened = await page.evaluate(`(() => {
    const summary = document.querySelector('[aria-label="Pre-release technical history"] summary');
    summary?.click();
    return summary != null;
  })()`);
  await settle(400);
  const technical = await page.evaluate(STATE);
  console.log('\nPre-release technical history');
  console.log(`  opened          ${opened === true && technical.technicalOpen === true ? 'yes' : 'NO'}`);
  console.log(`  content         ${technical.technicalText}`);
  await shoot(page, 'methodology-technical-history');

  // A reader arrives with a requirement id or title, so the full Version 1 list must remain searchable.
  await page.goto(`${ORIGIN}/methodology?q=delta`);
  await settle(900);
  const filtered = await page.evaluate(STATE);
  console.log('\nFiltered to "delta"');
  console.log(`  count           ${filtered.count}`);
  console.log(`  rows shown      ${String(filtered.shown)}`);
  console.log(`  first row       ${filtered.first}`);
  console.log(`  overflow        ${filtered.overflow === true ? 'YES' : 'no'}`);

  await page.goto(`${ORIGIN}/methodology?q=CO-01-04`);
  await settle(900);
  const one = await page.evaluate(STATE);
  console.log('\nOne requirement with thresholds and a precondition');
  console.log(`  ${one.first}`);

  // The forward-only case: remove the public identity from the latest scan and prove the page says
  // development record. Its catalogue revision remains in the response and must not become Version 1.
  await developmentRun(page);
  await page.goto(`${ORIGIN}/methodology`);
  await settle(900);
  const legacy = await page.evaluate(STATE);
  console.log('\nLatest scan predates public methodology identity (stubbed)');
  for (const line of legacy.standing) console.log(`  caption         ${line}`);
  console.log(`  public releases ${String(legacy.publicReleasePanels)}`);
  console.log(`  old selector    ${legacy.legacyReleaseSelector === true ? 'YES' : 'no'}`);
  console.log(`  overflow        ${legacy.overflow === true ? 'YES' : 'no'}`);
  await shoot(page, 'methodology-development-run');

  await page.resize(1280, 800);
  await settle(700);
  const small = await page.evaluate(STATE);
  console.log('\nThe same at 1280x800');
  console.log(`  rows shown      ${String(small.shown)}`);
  console.log(`  past window     ${String(small.past)}px${small.past > 0 ? ' — DOES NOT FIT' : ''}`);
  console.log(`  overflow        ${small.overflow === true ? 'YES' : 'no'}`);
} finally {
  await close();
}
