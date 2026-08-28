// Drive one exact review and record the customer identities it produces.
//
// This writes irreversible records, so it never chooses "latest" and never invents a human answer.
// Outstanding questions stop an all-confirmed path before the first pillar decision.
//
// TOKEN=... APP=https://... EMAIL=... DEFINITION=... RUN=... REVIEW=... \
// MODE=all-confirmed node scripts/drive-review.mjs
//
// MODE is all-confirmed, one-pillar-skipped, store-failure or restart-read. The skipped path also
// requires SKIP_PILLAR. Local runs write under .tmp-shots; served runs update the committed recording.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, settle } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDING = join(HERE, 'recordings/customer-journey.json');
const SERVED = join(HERE, 'recordings/served.json');
const origin = (process.env.APP ?? 'http://localhost:8000').replace(/\/$/, '');
const token = process.env.TOKEN ?? '';
const askedDefinition = process.env.DEFINITION ?? '';
const definitionId = askedDefinition === 'none' ? '' : askedDefinition;
const runId = process.env.RUN ?? '';
const reviewId = process.env.REVIEW ?? '';
const mode = process.env.MODE ?? '';
const supported = new Set(['all-confirmed', 'one-pillar-skipped', 'store-failure', 'restart-read']);

if (token === '' || askedDefinition === '' || !supported.has(mode)) {
  console.error('Set TOKEN, DEFINITION and MODE=all-confirmed|one-pillar-skipped|store-failure|restart-read.');
  process.exit(2);
}
if (mode !== 'store-failure' && (runId === '' || reviewId === '')) {
  console.error(`${mode} requires exact RUN and REVIEW values. This script never chooses the latest record.`);
  process.exit(2);
}
if (mode === 'one-pillar-skipped' && (process.env.SKIP_PILLAR ?? '') === '') {
  console.error('MODE=one-pillar-skipped requires SKIP_PILLAR.');
  process.exit(2);
}

const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(origin);
const output = process.env.OUTPUT ?? (local ? join(HERE, '../.tmp-shots/review/customer-journey.json') : RECORDING);
const shots = join(HERE, '../.tmp-shots/review');
mkdirSync(dirname(output), { recursive: true });
mkdirSync(shots, { recursive: true });

const page = await open({ width: 1512, height: 945 });
const failures = [];
const say = (ok, line) => {
  console.log(`${ok ? '✓' : '✗'} ${line}`);
  if (!ok) failures.push(line);
};
const scoped = (path) =>
  definitionId === ''
    ? path
    : `${path}${path.includes('?') ? '&' : '?'}definitionId=${encodeURIComponent(definitionId)}`;
const inAssessment = (path) =>
  definitionId === '' ? path : `${path}${path.includes('?') ? '&' : '?'}definition=${encodeURIComponent(definitionId)}`;
const api = async (path, init = {}) =>
  JSON.parse(
    await page.evaluate(`(async () => {
      const response = await fetch(${JSON.stringify(`${origin}${path}`)}, ${JSON.stringify(init)});
      const text = await response.text();
      let body = text;
      try { body = JSON.parse(text); } catch { /* keep raw bytes */ }
      return JSON.stringify({ status: response.status, body });
    })()`)
  );
const shot = async (name) => {
  try {
    writeFileSync(join(shots, `${name}.png`), await page.screenshot());
  } catch (cause) {
    console.log(`  (no screenshot for ${name}: ${cause instanceof Error ? cause.message : String(cause)})`);
  }
};
const press = async (prefix) =>
  JSON.parse(
    await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((one) => one.innerText.trim().startsWith(${JSON.stringify(prefix)}));
      if (button == null || button.disabled) return JSON.stringify({ clicked: false });
      button.click();
      return JSON.stringify({ clicked: true });
    })()`)
  );

await page.send('Network.enable');
await page.send('Network.setExtraHTTPHeaders', {
  headers: {
    Authorization: `Bearer ${token}`,
    'x-forwarded-access-token': token,
    ...(process.env.EMAIL != null && process.env.EMAIL !== '' ? { 'x-forwarded-email': process.env.EMAIL } : {}),
  },
});
// Establish the app as the document origin before any exact-record preflight calls `fetch`.
// Chrome refuses a credentialled cross-origin request from its initial `about:blank` document.
await page.goto(origin);
await settle(400);
const browser = await page.send('Browser.getVersion');

function readRecording() {
  return existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {};
}

function deployment() {
  if (local) return { id: 'local', origin };
  const served = JSON.parse(readFileSync(SERVED, 'utf8'));
  if (served.served?.origin !== origin || served.served?.deploymentId == null) {
    throw new Error('served.json does not name the APP origin being driven. Run served.mjs --serving first.');
  }
  return { id: served.served.deploymentId, origin };
}

function record(key, value) {
  const previous = readRecording();
  const next = {
    what: 'The exact pilot customer journeys driven in latest Chrome, joined by customer record ids to the served deployment and durable restart proof.',
    recordedAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(HERE, '..'), encoding: 'utf8' }).trim(),
    deployment: deployment(),
    browser: {
      product: browser.product ?? 'Chrome',
      version: browser.product?.split('/')[1] ?? browser.revision ?? '',
    },
    scenarios: { ...(previous.scenarios ?? {}), [key]: value },
  };
  writeFileSync(output, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nRecorded ${key} in ${output}.`);
}

async function controlledFailure() {
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const refusal = (code, message, action) => Promise.resolve(new Response(JSON.stringify({
          error: code, eligibility: { eligible: false, state: 'unreadable', reason: { code, message, action } }
        }), { status: 503, headers: { 'content-type': 'application/json' } }));
        if (url.includes('/api/results/current')) return refusal(
          'current-result-unreadable', 'The immutable final assessment store could not be read.',
          'Restore the review-store connection and reload the Dashboard.');
        if (/\\/api\\/months\\/[^/]+\\/preview/.test(url)) return refusal(
          'month-preview-unreadable', 'The inputs for this month could not be read.',
          'Restore the failed store connection and reload this preview before publishing.');
        return real(input, init);
      };
    })();`,
  });
  await page.goto(`${origin}${inAssessment('/overview')}`);
  await settle(1800);
  const dashboard = JSON.parse(
    await page.evaluate(`(() => JSON.stringify({
      text: document.body.innerText, scoreCards: document.querySelectorAll('.wa-scorecard').length
    }))()`)
  );
  say(/could not be read/i.test(dashboard.text), 'Dashboard states that the final result could not be read');
  say(dashboard.scoreCards === 0, 'Dashboard exposes no score card under the controlled failure');
  await shot('store-failure-dashboard');

  const months = await api(scoped('/api/months'));
  const month = months.body?.currentMonth ?? '';
  await page.goto(`${origin}${inAssessment(`/months/${month}`)}`);
  await settle(1800);
  const monthPage = JSON.parse(
    await page.evaluate(`(() => JSON.stringify({
      text: document.body.innerText,
      publishDisabled: [...document.querySelectorAll('button')].filter((one) => one.innerText.includes('Publish')).every((one) => one.disabled)
    }))()`)
  );
  say(/could not be read/i.test(monthPage.text), 'month preview states that its inputs could not be read');
  say(monthPage.publishDisabled === true, 'month publication remains disabled under the controlled failure');
  await shot('store-failure-month');
  if (failures.length > 0) return;
  record('storeFailure', {
    currentResult: { status: 503, code: 'current-result-unreadable', scoreExposed: dashboard.scoreCards > 0 },
    monthPreview: {
      status: 503,
      code: 'month-preview-unreadable',
      publicationEnabled: monthPage.publishDisabled !== true,
    },
  });
}

async function exactRecords() {
  const definitions = await api('/api/definitions');
  const definition =
    definitionId === ''
      ? { id: '', attribution: { name: 'unscoped assessment' } }
      : definitions.body?.definitions?.find((one) => one.id === definitionId);
  say(definition != null, `assessment ${definitionId === '' ? 'none (unscoped)' : definitionId} exists`);
  const scans = await api(scoped('/api/scans'));
  const run = scans.body?.scans?.find((one) => one.id === runId);
  say(run?.finishedAt != null, `run ${runId} is finished`);
  const review = await api(scoped(`/api/reviews/for/${runId}`));
  say(review.status === 200 && review.body?.id === reviewId, `run ${runId} belongs to exact review ${reviewId}`);
  return { definition, run, review: review.body };
}

async function restartRead() {
  const resultId = process.env.RESULT ?? '';
  const planId = process.env.PLAN ?? '';
  const actionId = process.env.ACTION ?? '';
  const foundationFingerprint = process.env.FOUNDATION_FINGERPRINT ?? '';
  const key = process.env.SCENARIO ?? '';
  if (
    !['allConfirmed', 'onePillarSkipped'].includes(key) ||
    [resultId, planId, actionId, foundationFingerprint].some((one) => one === '')
  ) {
    throw new Error(
      'restart-read requires SCENARIO=allConfirmed|onePillarSkipped and RESULT, PLAN, ACTION, FOUNDATION_FINGERPRINT.'
    );
  }
  await exactRecords();
  const result = await api(scoped(`/api/results/${resultId}`));
  const plan = await api(scoped(`/api/improvements/${planId}`));
  const foundation = await api(scoped('/api/foundation/serving'));
  // The current-month preview is deliberately not a restart identity. It is a live projection and a later
  // final assessment in the same month replaces the result it names. Both browser scenarios record the exact
  // month join when they create their result; the live Lakebase lifecycle is the separate proof that a frozen
  // monthly record survives reopening. Requiring this preview to retain both scenario result ids would demand
  // two mutually exclusive values from one current projection.
  say(result.body?.runId === runId && result.body?.reviewId === reviewId, 'restart read returns the exact result join');
  say(
    plan.body?.actions?.some((one) => one.id === actionId),
    'restart read returns the exact action'
  );
  say(
    foundation.body?.declaration?.fingerprint === foundationFingerprint,
    'restart read returns the foundation declaration'
  );
  if (failures.length > 0) return;
  const previous = readRecording();
  const scenario = previous.scenarios?.[key];
  if (scenario == null) throw new Error(`The recording has no ${key} scenario.`);
  record(key, {
    ...scenario,
    restartRead: {
      runId,
      reviewId,
      resultId,
      actionId,
      foundationFingerprint,
    },
  });
}

async function driveReview() {
  const { review } = await exactRecords();
  // Everything below can write an irreversible review decision. An exact-selection failure is a
  // stop condition, not merely a failed assertion to report after a different review was changed.
  if (failures.length > 0) return;
  const catalogue = await api('/api/catalogue');
  const pillars = catalogue.body?.pillars ?? [];
  say(pillars.length === 7, `catalogue names seven pillars (${String(pillars.length)})`);
  await page.goto(`${origin}${inAssessment(`/review/${reviewId}`)}`);
  await settle(1600);
  const recorded = new Set((review?.pillars ?? []).map((one) => one.pillarId));
  const pending = pillars.filter((one) => !recorded.has(one.id));
  const skipPillar = mode === 'one-pillar-skipped' ? process.env.SKIP_PILLAR : undefined;
  say(
    skipPillar == null || pillars.some((one) => one.id === skipPillar),
    `skip pillar ${skipPillar ?? 'not requested'}`
  );

  const blocked = [];
  for (const pillar of pending) {
    if (pillar.id === skipPillar) continue;
    await page.evaluate(`document.querySelector(${JSON.stringify(`[data-pillar="${pillar.id}"]`)})?.click()`);
    await settle(500);
    const attention = JSON.parse(
      await page.evaluate(`(() => JSON.stringify([...document.querySelectorAll('.wa-assess-question-link')]
        .map((one) => new URL(one.href).searchParams.get('control')).filter(Boolean)))()`)
    );
    if (attention.length > 0) blocked.push({ pillarId: pillar.id, controls: attention });
  }
  if (blocked.length > 0) {
    for (const one of blocked) say(false, `${one.pillarId} still needs human answers: ${one.controls.join(', ')}`);
    return;
  }

  for (const pillar of pending) {
    await page.evaluate(`document.querySelector(${JSON.stringify(`[data-pillar="${pillar.id}"]`)})?.click()`);
    await settle(500);
    const decision = pillar.id === skipPillar ? 'Skip' : 'Confirm';
    say((await press(decision)).clicked === true, `${decision.toLowerCase()} asks before writing ${pillar.title}`);
    await settle(350);
    say(
      (await press(`${decision} ${pillar.title}`)).clicked === true,
      `${decision.toLowerCase()} writes ${pillar.title}`
    );
    await settle(1400);
  }
  await shot(`${mode}-finished`);
  const after = await api(scoped(`/api/reviews/${reviewId}`));
  const result = after.body?.result;
  say(result?.runId === runId, `final result cites run ${runId}`);
  say(result?.reviewId === reviewId, `final result cites review ${reviewId}`);
  say(result?.id != null && result.id !== runId, `final result has its own identity ${result?.id ?? 'missing'}`);
  if (result == null || failures.length > 0) return;

  await page.goto(`${origin}${inAssessment(`/report/${result.id}`)}`);
  await settle(1800);
  const report = JSON.parse(
    await page.evaluate(`(() => JSON.stringify({
      path: location.pathname, errors: document.querySelectorAll('.wa-error,[role="alert"]').length
    }))()`)
  );
  say(report.path === `/report/${result.id}` && report.errors === 0, 'the exact final-result report renders');
  const exported = await api(scoped(`/api/results/${result.id}/export.json`));
  say(exported.body?.review?.finalResultId === result.id, 'the export names the immutable final result');

  const definition = result.finalAssessment?.definition;
  const finding = result.finalAssessment?.outcome?.findings?.[0]?.finding;
  say(definition?.id === definitionId, 'the result retains the assessment identity');
  say(finding?.controlId != null, 'the result has an actionable requirement');
  if (definition == null || finding?.controlId == null) return;

  const plan = await api(scoped('/api/improvements'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: `Pilot journey ${result.id.slice(0, 8)}`,
      outcome: 'The selected Well-Architected requirement has a named owner and a verifiable completion check.',
      owners: [process.env.EMAIL ?? 'platform-engineering'],
      assessment: { definitionId, version: definition.version },
      raisedFrom: runId,
    }),
  });
  say(plan.status === 201, `created an improvement plan from run ${runId}`);
  const action = await api(scoped(`/api/improvements/${plan.body?.id ?? ''}/actions`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      controlIds: [finding.controlId],
      outcome: 'The selected requirement is remediated and the next assessment can measure the changed state.',
      definitionOfDone: 'The exact workspace change is complete and a later assessment no longer reports this finding.',
      owner: process.env.EMAIL ?? 'platform-engineering',
      priority: 'now',
      effort: 'small',
      steps: ['Open the linked Databricks resource.', 'Apply the recommended change.', 'Run the assessment again.'],
      dependsOn: [],
      raisedFrom: runId,
    }),
  });
  say(action.status === 201, 'created an actionable improvement under that plan');
  await page.goto(`${origin}${inAssessment(`/improvements/${plan.body?.id ?? ''}`)}`);
  await settle(1200);
  await shot(`${mode}-action`);

  const foundation = await api(scoped('/api/foundation/serving'));
  say(foundation.body?.declaration?.definitionId === definitionId, 'foundation declaration names the assessment');
  const months = await api(scoped('/api/months'));
  const month = months.body?.currentMonth ?? '';
  const preview = await api(scoped(`/api/months/${month}/preview`));
  const monthIdentity = preview.body?.content?.assessment;
  say(monthIdentity?.finalResultId === result.id, `month ${month} reads the same final result`);
  say(monthIdentity?.runId === runId && monthIdentity?.reviewId === reviewId, 'month retains the run and review join');
  if (failures.length > 0) return;

  record(mode === 'all-confirmed' ? 'allConfirmed' : 'onePillarSkipped', {
    runId,
    reviewId,
    resultId: result.id,
    definition: { id: definition.id, version: definition.version, fingerprint: definition.fingerprint },
    pillarDecisions: {
      confirmed: result.pillars.filter((one) => one.kind === 'confirmed').length,
      skipped: result.pillars.filter((one) => one.kind === 'skipped').map((one) => one.pillarId),
    },
    report: { path: `/report/${result.id}`, resultId: result.id },
    export: { path: `/api/results/${result.id}/export.json`, finalResultId: exported.body.review.finalResultId },
    improvement: {
      planId: plan.body.id,
      actionId: action.body.id,
      raisedFrom: action.body.raisedFrom,
      definitionId: plan.body.assessment?.definitionId,
      definitionVersion: plan.body.assessment?.version,
    },
    foundation: {
      definitionId: foundation.body.declaration.definitionId,
      version: foundation.body.declaration.version,
      fingerprint: foundation.body.declaration.fingerprint,
    },
    month: {
      month,
      runId: monthIdentity.runId,
      reviewId: monthIdentity.reviewId,
      finalResultId: monthIdentity.finalResultId,
      definitionId: monthIdentity.definition?.id,
      definitionVersion: monthIdentity.definition?.version,
    },
  });
}

try {
  if (mode === 'store-failure') await controlledFailure();
  else if (mode === 'restart-read') await restartRead();
  else await driveReview();
} finally {
  page.close();
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} check(s) failed.`);
  process.exit(1);
}
console.log(`\n${mode} journey passed.`);
