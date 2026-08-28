// The joined pilot journey record.
//
// Browser recordings, served-route coverage and the live Lakebase suite each answer a different
// question. This file joins them without copying their facts into prose: the browser record names
// exact customer identities, served.json names the deployment and route census, and live-suite.json
// names the SQL/restart proof. `--check` refuses a green-looking record when any identity is swapped,
// when a raw run is used where the immutable final result is required, or when the named deployed
// source commit is not in the candidate's history. The recording is historical release evidence:
// later development does not rewrite or invalidate what that named deployment proved.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const ROOT = join(APP, '..');

export const RECORDING = join(HERE, 'recordings/customer-journey.json');
export const SERVED = join(HERE, 'recordings/served.json');
export const LIVE = join(HERE, 'recordings/live-suite.json');

const SOURCE_RECORDINGS = [
  ['served', SERVED],
  ['live', LIVE],
];

const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

function same(problems, actual, expected, label) {
  if (text(actual) == null) problems.push(`${label} is missing.`);
  else if (actual !== expected) problems.push(`${label} is ${String(actual)}, expected ${String(expected)}.`);
}

function scenarioProblems(name, scenario) {
  const problems = [];
  if (scenario == null || typeof scenario !== 'object') return [`${name} is missing.`];

  const runId = text(scenario.runId);
  const reviewId = text(scenario.reviewId);
  const resultId = text(scenario.resultId);
  const definition = scenario.definition ?? {};
  const expected = name === 'allConfirmed' ? { confirmed: 7, skipped: 0 } : { confirmed: 6, skipped: 1 };

  if (runId == null) problems.push(`${name}.runId is missing.`);
  if (reviewId == null) problems.push(`${name}.reviewId is missing.`);
  if (resultId == null) problems.push(`${name}.resultId is missing.`);
  if (resultId != null && resultId === runId) {
    problems.push(
      `${name}.resultId is the raw run id; customer result consumers require the immutable final-result id.`
    );
  }
  if (text(definition.id) == null) problems.push(`${name}.definition.id is missing.`);
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    problems.push(`${name}.definition.version is not a positive integer.`);
  }
  if (text(definition.fingerprint) == null) problems.push(`${name}.definition.fingerprint is missing.`);

  const decisions = scenario.pillarDecisions ?? {};
  if (decisions.confirmed !== expected.confirmed) {
    problems.push(
      `${name} records ${String(decisions.confirmed)} confirmed pillars, expected ${String(expected.confirmed)}.`
    );
  }
  if (!Array.isArray(decisions.skipped) || decisions.skipped.length !== expected.skipped) {
    problems.push(
      `${name} records ${String(decisions.skipped?.length ?? 'no')} skipped pillars, expected ${String(expected.skipped)}.`
    );
  }

  same(problems, scenario.report?.resultId, resultId, `${name}.report.resultId`);
  same(problems, scenario.export?.finalResultId, resultId, `${name}.export.finalResultId`);
  same(problems, scenario.improvement?.raisedFrom, runId, `${name}.improvement.raisedFrom`);
  same(problems, scenario.improvement?.definitionId, definition.id, `${name}.improvement.definitionId`);
  if (scenario.improvement?.definitionVersion !== definition.version) {
    problems.push(`${name}.improvement.definitionVersion does not match the reviewed assessment version.`);
  }
  if (text(scenario.improvement?.planId) == null) problems.push(`${name}.improvement.planId is missing.`);
  if (text(scenario.improvement?.actionId) == null) problems.push(`${name}.improvement.actionId is missing.`);

  same(problems, scenario.foundation?.definitionId, definition.id, `${name}.foundation.definitionId`);
  if (text(scenario.foundation?.fingerprint) == null) problems.push(`${name}.foundation.fingerprint is missing.`);

  same(problems, scenario.month?.runId, runId, `${name}.month.runId`);
  same(problems, scenario.month?.reviewId, reviewId, `${name}.month.reviewId`);
  same(problems, scenario.month?.finalResultId, resultId, `${name}.month.finalResultId`);
  same(problems, scenario.month?.definitionId, definition.id, `${name}.month.definitionId`);
  if (scenario.month?.definitionVersion !== definition.version) {
    problems.push(`${name}.month.definitionVersion does not match the reviewed assessment version.`);
  }
  if (!/^\d{4}-\d{2}$/.test(scenario.month?.month ?? '')) problems.push(`${name}.month.month is not YYYY-MM.`);

  const restarted = scenario.restartRead ?? {};
  same(problems, restarted.runId, runId, `${name}.restartRead.runId`);
  same(problems, restarted.reviewId, reviewId, `${name}.restartRead.reviewId`);
  same(problems, restarted.resultId, resultId, `${name}.restartRead.resultId`);
  same(problems, restarted.actionId, scenario.improvement?.actionId, `${name}.restartRead.actionId`);
  same(
    problems,
    restarted.foundationFingerprint,
    scenario.foundation?.fingerprint,
    `${name}.restartRead.foundationFingerprint`
  );
  // `scenario.month` holds the live preview's exact join when this result was current. Do not require that
  // projection to keep naming it after the other scenario finishes in the same month. Durable monthly restart
  // identity belongs to the frozen record exercised by `live.lifecycle` below.

  return problems;
}

export function journeyProblems(recording, served, live, source = {}) {
  const problems = [];
  if (recording == null || typeof recording !== 'object') return ['customer-journey.json is missing or unreadable.'];

  const deployment = recording.deployment ?? {};
  same(problems, deployment.id, served?.served?.deploymentId, 'deployment.id');
  same(problems, deployment.origin, served?.served?.origin, 'deployment.origin');
  same(problems, served?.driven?.deploymentId, served?.served?.deploymentId, 'served route-census deployment id');
  same(problems, served?.driven?.origin, served?.served?.origin, 'served route-census origin');
  if (served?.driven?.drove !== served?.driven?.declared || served?.driven?.declared !== 37) {
    problems.push(
      `served route census is ${String(served?.driven?.drove ?? 'unknown')} of ` +
        `${String(served?.driven?.declared ?? 'unknown')}, expected 37 of 37.`
    );
  }
  if (served?.driven?.failures !== 0)
    problems.push(`served route census records ${String(served?.driven?.failures)} failures.`);

  if (text(recording.sourceCommit) == null) problems.push('sourceCommit is missing.');
  if (source.ancestor === false)
    problems.push(`sourceCommit ${String(recording.sourceCommit)} is not an ancestor of HEAD.`);
  if (text(recording.browser?.product) == null || text(recording.browser?.version) == null) {
    problems.push('browser product/version is missing.');
  }
  problems.push(...scenarioProblems('allConfirmed', recording.scenarios?.allConfirmed));
  problems.push(...scenarioProblems('onePillarSkipped', recording.scenarios?.onePillarSkipped));

  const all = recording.scenarios?.allConfirmed;
  const skipped = recording.scenarios?.onePillarSkipped;
  for (const field of ['runId', 'reviewId', 'resultId']) {
    if (text(all?.[field]) != null && all[field] === skipped?.[field]) {
      problems.push(
        `the two customer paths reuse ${field} ${String(all[field])}; they must prove independent reviews.`
      );
    }
  }

  const failure = recording.scenarios?.storeFailure ?? {};
  if (failure.currentResult?.status !== 503 || text(failure.currentResult?.code) == null) {
    problems.push('storeFailure.currentResult does not record the controlled 503 and structured code.');
  }
  if (failure.currentResult?.scoreExposed !== false) problems.push('storeFailure.currentResult exposed a score.');
  if (failure.monthPreview?.status !== 503 || text(failure.monthPreview?.code) == null) {
    problems.push('storeFailure.monthPreview does not record the controlled 503 and structured code.');
  }
  if (failure.monthPreview?.publicationEnabled !== false)
    problems.push('storeFailure.monthPreview enabled publication.');

  same(problems, live?.commit, recording.sourceCommit, 'live-suite commit');
  if (live?.lifecycle?.restarted !== true) problems.push('live-suite.json does not record the lifecycle restart read.');
  const lifecycle = live?.lifecycle ?? {};
  for (const [field, value] of [
    ['definition.id', lifecycle.definition?.id],
    ['definition.fingerprint', lifecycle.definition?.fingerprint],
    ['runId', lifecycle.runId],
    ['reviewId', lifecycle.reviewId],
    ['resultId', lifecycle.resultId],
    ['planId', lifecycle.planId],
    ['actionId', lifecycle.actionId],
    ['foundationFingerprint', lifecycle.foundationFingerprint],
    ['monthId', lifecycle.monthId],
  ]) {
    if (text(value) == null) problems.push(`live-suite lifecycle ${field} is missing.`);
  }
  if (!Number.isInteger(lifecycle.definition?.version) || lifecycle.definition.version < 1) {
    problems.push('live-suite lifecycle definition.version is not a positive integer.');
  }
  if (text(lifecycle.resultId) != null && lifecycle.resultId === lifecycle.runId) {
    problems.push('live-suite lifecycle resultId is the raw run id.');
  }
  same(problems, lifecycle.monthFinalResultId, lifecycle.resultId, 'live-suite lifecycle monthFinalResultId');
  if (text(lifecycle.rollback?.runId) == null || text(lifecycle.rollback?.reviewId) == null) {
    problems.push('live-suite lifecycle rollback run/review identity is missing.');
  }
  if (lifecycle.rollback?.runId === lifecycle.runId || lifecycle.rollback?.reviewId === lifecycle.reviewId) {
    problems.push('live-suite lifecycle rollback reuses the successful run or review identity.');
  }
  if (lifecycle.rollback?.terminalPillarWritten !== false || lifecycle.rollback?.resultWritten !== false) {
    problems.push('live-suite.json does not record terminal projection rollback without a pillar or result write.');
  }

  return problems;
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function sourceFile(commit, path) {
  return execFileSync('git', ['show', `${commit}:${relative(ROOT, path)}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

/** The commit that made the journey and its sibling recordings one evidence envelope. */
export function customerJourneyEvidenceCommit(history = git) {
  return history('log', '-1', '--format=%H', 'HEAD', '--', relative(ROOT, RECORDING));
}

/** Read the two release recordings from the commit that recorded the customer journey. */
export function historicalEvidence(commit, read = sourceFile) {
  const evidence = { problems: [] };
  if (text(commit) == null) {
    evidence.problems.push('customer-journey evidence commit is missing.');
    return evidence;
  }

  for (const [name, path] of SOURCE_RECORDINGS) {
    const repositoryPath = relative(ROOT, path);
    let contents;
    try {
      contents = read(commit, path);
    } catch {
      evidence.problems.push(`evidence commit ${commit} does not contain ${repositoryPath}.`);
      continue;
    }
    try {
      evidence[name] = JSON.parse(contents);
    } catch {
      evidence.problems.push(`${repositoryPath} at evidence commit ${commit} is not valid JSON.`);
    }
  }
  return evidence;
}

function sourceState(commit) {
  if (text(commit) == null) return { problems: [] };
  let ancestor = false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: ROOT, stdio: 'ignore' });
    ancestor = true;
  } catch {
    // Reported by the caller with the commit that failed.
  }
  return { ancestor };
}

function check() {
  if (!existsSync(RECORDING)) {
    console.log('Pilot customer journey proof is pending ledger row 107i.');
    return;
  }
  const recording = JSON.parse(readFileSync(RECORDING, 'utf8'));
  const source = sourceState(recording.sourceCommit);
  const evidence = historicalEvidence(customerJourneyEvidenceCommit());
  const problems = [...evidence.problems, ...journeyProblems(recording, evidence.served, evidence.live, source)];
  if (problems.length > 0)
    throw new Error(
      `The pilot customer journey proof does not reconcile:\n\n${problems.map((one) => `  - ${one}`).join('\n')}`
    );
  console.log(
    `Pilot journey reconciles two customer paths, controlled failures, 37 served routes and the durable restart proof ` +
      `on deployment ${recording.deployment.id}.`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) check();
  else console.log(JSON.stringify({ recording: relative(APP, RECORDING), head: git('rev-parse', 'HEAD') }, null, 2));
}
