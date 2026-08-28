#!/usr/bin/env node
// The scheduled job supervises the run, and the app executes it — held to that from both ends.
//
// ADR 0060 split the work: the job triggers, supervises, retries and cancels, and the app does the
// assessment. Everything that makes the split safe rather than merely tidy lives in two files that
// nothing else connects — a notebook and a job definition — and none of it typechecks. A parameter
// renamed in one and not the other, a retry policy quietly dropped, a path the app no longer serves:
// each of those turns an unattended weekly assessment into a task that fails at six on Monday, or
// worse, one that appears to succeed.
//
// So the properties are checked rather than described. The three that matter most:
//
//   * A retry joins the run it already started. That is the whole argument for retrying at all, and it
//     rests on one string — the idempotency key — being built from the job run rather than from the
//     attempt. Get that wrong and three retries are four assessments of the same night, four warehouse
//     bills, and a trend line with a step in it.
//   * The blindness verdict is the app's. A scheduled run that could not read the estate must fail the
//     task, and the app decides that. A copy of the rule in the notebook would agree with the app until
//     the day one of them changed, and then it would quietly report an unread estate as a good one.
//   * Cancelling the task cancels the assessment. Otherwise stopping the job stops only the waiting.
//
// Read from the code rather than the prose, via the same tokeniser `check-evidence-script.mjs` uses,
// because this file's arguments are made in comments in that one and a check that matched them would
// pass on a notebook that says the right thing and does nothing.

import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { codeOf } from './python-code.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTEBOOK = join(APP, 'schedule', 'trigger.py');
const JOB = join(APP, 'resources', 'scheduled-scan.yml');
const API = join(APP, 'server', 'api');

const failures = [];

function check(label, ok, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
  if (!ok) failures.push(detail ?? label);
}

let code = '';
try {
  code = codeOf(NOTEBOOK);
} catch (problem) {
  console.error(
    `\nCould not read trigger.py as Python: ${problem.message}\n` +
      'This check tokenises the notebook to tell its code from its prose, so it needs python3 on PATH.'
  );
  process.exit(1);
}

const job = parse(readFileSync(JOB, 'utf8')).resources.jobs.scheduled_assessment;
const taskNamed = (key) => job.tasks.find((one) => one.task_key === key);
const parametersOf = (key) => taskNamed(key)?.notebook_task?.base_parameters ?? {};
const task = taskNamed('assess');
const parameters = parametersOf('assess');
/** Every parameter any task sets, since the two phases pass different subsets of the same widgets. */
const anyParameter = new Set(job.tasks.flatMap((one) => Object.keys(one.notebook_task?.base_parameters ?? {})));

// ---------------------------------------------------------------------------------------------
// The job and the notebook agree on what is passed
//
// Two files, no shared type, and a mismatch degrades rather than fails: a widget nobody sets reads
// back as its default, so a renamed `client_id` becomes an empty one and the task fails on a message
// about an empty parameter rather than about the rename. Checked in both directions, because an
// unused parameter in the job is the same rename seen from the other side.
// ---------------------------------------------------------------------------------------------

console.log('The job and the notebook agree on what is passed');

const widgets = [...code.matchAll(/dbutils\s*\.\s*widgets\s*\.\s*text\s*\(\s*"([^"]+)"/g)].map((one) => one[1]);

check(
  'every parameter the notebook declares is one some task sets',
  widgets.every((name) => anyParameter.has(name)),
  `The notebook declares ${widgets.filter((name) => !anyParameter.has(name)).join(', ')}, which no task ` +
    `in ${JOB} sets. An unset widget reads back as its default, so this fails at six on Monday.`
);

for (const key of job.tasks.filter((one) => one.notebook_task != null).map((one) => one.task_key)) {
  const set = Object.keys(parametersOf(key));
  check(
    `every parameter the ${key} task sets is one the notebook declares`,
    set.every((name) => widgets.includes(name)),
    `${JOB} has the ${key} task set ${set
      .filter((name) => !widgets.includes(name))
      .join(', ')}, which the notebook does not read. Either the notebook lost a widget or the job is ` +
      'passing something to nothing.'
  );
}

// ---------------------------------------------------------------------------------------------
// A retry joins the run rather than starting another
//
// The one property that makes retrying safe. The key has to name the job run, because that is what
// stays the same across an automatic retry and changes on the next schedule tick; and it has to
// include the repair count, because a person asking again has fixed something and resuming would skip
// the very signals their fix was meant to clear.
// ---------------------------------------------------------------------------------------------

console.log('\nA retry joins the run rather than starting another');

check(
  'the job passes the run identity a key can be built from',
  parameters.job_run_id === '{{job.run_id}}' && parameters.repair_count === '{{job.repair_count}}',
  `${JOB} must pass job_run_id: '{{job.run_id}}' and repair_count: '{{job.repair_count}}'. Lakeflow ` +
    'substitutes both when the run starts; without them the notebook has nothing to key on and every ' +
    'retry is a second assessment of the same night.'
);

check(
  'the notebook builds its key from the job run and the repair count',
  /job_run_id/.test(code) && /repair_count/.test(code),
  'The notebook must use both job_run_id and repair_count in the key it posts. Keyed on the task or ' +
    'the clock instead, a retry starts a new run and the checkpoint it should have resumed from is ' +
    'never read.'
);

check(
  'the notebook sends the key as an idempotency key',
  /"idempotency-key"/.test(code),
  'The notebook must send its key in the `idempotency-key` header. The app accepts it there or in the ' +
    'body; what it cannot do is infer it, and without it every post is a new run.'
);

check(
  'the task retries, and retries a timeout',
  (task?.max_retries ?? 0) >= 1 && task?.retry_on_timeout === true,
  `${JOB} must set max_retries and retry_on_timeout on the assess task. The supervision this whole ` +
    'file is about is the retry: without it an app restarted mid-scan loses the week, even though the ' +
    'run record can carry on from its last checkpoint.'
);

// ---------------------------------------------------------------------------------------------
// The refusals a retry cannot clear are found before the retrying starts
//
// The split is only worth its extra serverless start if the first task cannot retry and the second
// cannot run without it. Lose either and the job is back to discovering a missing grant four times:
// once for the answer, three more for the retries — which is what it did before this phase existed,
// measured at seven and a half minutes of startup for 47 seconds of work.
// ---------------------------------------------------------------------------------------------

console.log('\nThe refusals a retry cannot clear are found before the retrying starts');

const readiness = taskNamed('readiness');

check(
  'a readiness task runs the same notebook in its readiness phase',
  readiness?.notebook_task?.notebook_path === task?.notebook_task?.notebook_path &&
    parametersOf('readiness').phase === 'readiness',
  `${JOB} must have a readiness task running the same notebook with phase: 'readiness'. A second ` +
    'notebook would be a second copy of the parameters, the secret and the OAuth grant, and the copy ' +
    'that drifts is the one checking whether the other can run.'
);

check(
  'it does not retry, because its answer will not change',
  (readiness?.max_retries ?? 0) === 0,
  `${JOB} must leave max_retries at 0 on the readiness task. A settled refusal — an identity outside ` +
    'the group, no warehouse bound — costs one serverless start when it is asked once and four when it ' +
    'is retried, and the answer is the same every time.'
);

check(
  'retries stay per task, so the panel describing them describes all of them',
  job?.max_retries === undefined,
  `${JOB} must not set a job-level max_retries. The app reads the per-task policy and SchedulePanel ` +
    'presents it as what happens on a failure, so a job-level policy would leave that sentence describing ' +
    'half of what retries. It is also a different mechanism: the Jobs API creates a new run per job-level ' +
    'attempt, so the original stays terminal and failed while its retry runs, and a reader would see a run ' +
    'the app calls failed beside a retry the app cannot connect to it.'
);

check(
  'the assessment waits for it',
  (task?.depends_on ?? []).some((one) => one.task_key === 'readiness'),
  `${JOB} must have the assess task depend on readiness. Without the dependency both tasks start at ` +
    'once and the check costs a start without saving one.'
);

check(
  'and the assessment says which phase it is',
  parameters.phase === 'assess',
  `${JOB} must pass phase: 'assess' on the assess task. The notebook defaults to assessing, so this ` +
    'is not what makes it work — it is what makes the two tasks legible as the two halves they are.'
);

check(
  'and the notebook fails as a task rather than by exiting the interpreter',
  !/SystemExit\s*\(/.test(code),
  'The notebook raises SystemExit. Measured on labs: that exits the interpreter, the run is recorded ' +
    'as INTERNAL_ERROR rather than a failed task, and the platform retries an internal error whatever ' +
    'the retry policy says — so a readiness task with max_retries at 0 ran twice on a refusal that ' +
    'could not change. Raise TaskFailed instead.'
);

check(
  'the notebook has a readiness phase that asks before starting anything',
  /phase\s*==\s*"readiness"/.test(code) && /def\s+check_readiness\s*\(/.test(code),
  'The notebook must branch on the phase and have a readiness path that does not start a scan. A ' +
    'readiness task that fell through to the assessment would run it twice, and the second run would ' +
    'be the one with no retries.'
);

check(
  'and it reads the permission answer rather than deciding for itself',
  /"may"/.test(code) && /"start"/.test(code),
  'The readiness phase must read `may.start` from the app. A notebook that decided permission for ' +
    'itself would be a copy of the gate, and the copy that passes where the gate refuses moves the ' +
    'failure to the task that has already paid for its start.'
);

// The two ways a preflight costs more than it saves, and they are both about an app that says nothing.
//
// The first version of this phase waited out a restart on the supervisor's 50-minute clock inside a
// task the platform kills at fifteen minutes, so a twenty-minute restart failed readiness on a
// timeout and skipped the assessment — a missed week, caused by the phase that exists to save one.
// The second is what the timeout would have done anyway: treating silence as a refusal.
//
// Held as arithmetic rather than as a sentence, because the numbers are in two files and the failure
// is invisible until the week an app takes longer than usual to come back.

/** A serverless start, at the high end of what was measured on labs, so the wait fits around one. */
const START_SECONDS = 300;
const budget = Number(/READINESS_WAIT_UP_TO_SECONDS\s*=\s*(\d+)/.exec(code)?.[1] ?? NaN);

check(
  'its wait fits inside the timeout the platform kills it at',
  Number.isFinite(budget) && budget + START_SECONDS <= (readiness?.timeout_seconds ?? 0),
  `The readiness phase waits up to ${String(budget)}s and its task times out at ` +
    `${String(readiness?.timeout_seconds ?? 0)}s. The wait has to fit inside the timeout with a ` +
    `serverless start (~${String(START_SECONDS)}s) to spare, or the platform kills the task before ` +
    'the notebook gives up and a long restart fails readiness instead of being waited out. Either ' +
    'lower READINESS_WAIT_UP_TO_SECONDS in the notebook or raise timeout_seconds on the task.'
);

check(
  'and running out of it checks nothing rather than refusing the week',
  /def\s+unchecked\s*\(/.test(code) && [...code.matchAll(/\bunchecked\s*\(/g)].length >= 3,
  'When the readiness phase runs out of patience it must return through `unchecked` — from both the ' +
    '5xx branch and the unreachable one — rather than fail. An app that never answered has refused ' +
    'nothing, and failing here skips a run the supervisor would have finished on its second retry. ' +
    'This phase acts on answers only.'
);

// ---------------------------------------------------------------------------------------------
// The verdicts are the app's
//
// A notebook that re-derives whether a run was worth keeping is a second copy of a judgement, and the
// copies agree until one changes. The pattern is deliberately crude — any comparison of `measured`
// against `requirements` in code — because there is no legitimate reason for the notebook to relate
// those two numbers, and the crude version cannot be argued around in review.
// ---------------------------------------------------------------------------------------------

console.log('\nThe verdicts are the app\u2019s');

check(
  'the notebook reads the blind verdict rather than working one out',
  /"blind"/.test(code),
  'The notebook must fail the task on the summary\u2019s `blind` flag. That flag is the app saying the ' +
    'run read less of the estate than it failed to read, which is the failure a scheduled assessment ' +
    'exists to notice.'
);

check(
  'the notebook never compares what was measured with what was asked',
  !/(measured[^;]{0,40}[<>][^;]{0,40}requirements)|(requirements[^;]{0,40}[<>][^;]{0,40}measured)/.test(code),
  'The notebook compares measured against requirements. That is the app\u2019s rule for whether a run ' +
    'is worth keeping, and a copy of it here would go on agreeing with the app right up until the day ' +
    'the rule changed.'
);

// ---------------------------------------------------------------------------------------------
// What it waits out, and what it does not
//
// The supervision is a set of waits, and both ways of getting one wrong are silent. A wait with no
// bound is a task that hangs until the platform kills it mid-sentence, saying nothing about the run it
// was following. And a question the app was too down to answer is not an answer: reading "no run" out
// of a failed read turns a restart — the case the durable run exists for — into a failure that tells an
// operator to bind a database that has been bound all along.
// ---------------------------------------------------------------------------------------------

console.log('\nWhat it waits out, and what it does not');

// Every sleep, however its duration is worked out. An earlier version matched `sleep(WAIT_SECONDS`
// exactly, which stopped counting the moment a wait was written as `sleep(min(WAIT_SECONDS, …))` —
// so the readiness phase's waits were unbounded as far as this check was concerned.
const sleeps = [...code.matchAll(/time\s*\.\s*sleep\s*\(/g)].length;
const bounds = [...code.matchAll(/time\s*\.\s*monotonic\s*\(\s*\)\s*[<>]=?\s*give_up_at/g)].length;

check(
  'every wait it takes is bounded by the clock it gives up on',
  sleeps > 0 && bounds >= sleeps,
  `The notebook waits in ${sleeps} places and tests the give-up clock in ${bounds}. Each wait needs ` +
    'its own bound: the task\u2019s timeout is the real limit, and a wait that runs into it is killed ' +
    'mid-sentence, leaving a job history that names no run and no reason.'
);

check(
  'asking about the run can say it could not ask, rather than only that there is no run',
  /def\s+our_run\s*\(\s*\)\s*->\s*tuple\s*\[/.test(code) && /UNREACHABLE/.test(code) && /NO_STORE/.test(code),
  'The notebook must tell an app it could not reach from an app that keeps no runs. Both come back ' +
    'empty, and only the second is worth failing for: the first is what a restart looks like from ' +
    'here, and the answer to it is the same wait as everything else.'
);

check(
  'and only an app with nowhere to record runs ends the task',
  /state\s*==\s*NO_STORE/.test(code),
  'The fatal branch after a lost connection must key off there being no run store, not off there ' +
    'being no run in hand. A key that names no run yet means the connection broke before the app ' +
    'wrote the record, and posting the key again is what writes it.'
);

// ---------------------------------------------------------------------------------------------
// Cancelling the task cancels the assessment
// ---------------------------------------------------------------------------------------------

console.log('\nCancelling the task cancels the assessment');

check(
  'the notebook catches the interrupt a cancelled task arrives as',
  /KeyboardInterrupt/.test(code),
  'The notebook must catch KeyboardInterrupt. That is how a cancelled notebook task arrives, and ' +
    'without catching it, cancelling the job stops the waiting and leaves the app reading the estate ' +
    'for a supervisor that no longer exists.'
);

check(
  'and asks the app to stop the run it started',
  /\/cancel/.test(code),
  'The notebook must post to the run\u2019s cancel path on the way out. The app then ends the run as ' +
    'cancelled with what it had reached — a state somebody can read, rather than a run that appears ' +
    'to be going for ever.'
);

// ---------------------------------------------------------------------------------------------
// Every path it calls is one the app serves
//
// The failure this catches is a route renamed in the app, which no test of either side would notice:
// the notebook is not imported by anything, and the app's tests assert its own paths. What an
// operator would see is a scheduled run failing on a 404 from a path that used to work.
// ---------------------------------------------------------------------------------------------

console.log('\nEvery path it calls is one the app serves');

const served = new Set(
  readdirSync(API)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .flatMap((file) => [...readFileSync(join(API, file), 'utf8').matchAll(/app\.(get|post)\('([^']+)'/g)])
    .map((one) => `${one[1]} ${one[2]}`)
);

for (const [method, path] of [
  ['post', '/api/scan/scheduled'],
  ['get', '/api/scan/readiness'],
  ['get', '/api/runs'],
  ['post', '/api/runs/:id/cancel'],
]) {
  check(
    `the app serves ${method.toUpperCase()} ${path}`,
    served.has(`${method} ${path}`),
    `The notebook calls ${path}, and no route in server/api serves ${method.toUpperCase()} of it. A ` +
      'scheduled run would fail on a 404 from a path that used to work.'
  );
}

// The notebook's own end of the same agreement. Matched loosely, because a path built in an f-string
// arrives from the tokeniser in pieces, and a check that demanded the whole literal would forbid
// building one.
for (const fragment of ['/api/scan/scheduled', '/api/scan/readiness', '/api/runs']) {
  check(
    `the notebook names ${fragment}`,
    code.includes(fragment),
    `The notebook no longer names ${fragment}. Either it stopped doing something it is checked for ` +
      'above, or it is reaching the app by a path this check cannot see.'
  );
}

// ---------------------------------------------------------------------------------------------
// The app can read what the bundle decided
//
// AUD-DEC-108 makes this file authoritative for four things — schedule, run-as identity, retries and
// notifications — and the app's job is to show all four so that a reader can check them without the
// repository. Two of the four are read by name, and a name is a thing that drifts.
//
// The retry policy is per task and the two tasks differ on purpose: `readiness` does not retry a
// settled permission refusal, `assess` retries because its failures are transient. So `schedule.ts`
// picks the assessment task out by key, and a rename here without one there means it finds no task and
// the panel silently stops saying anything about retries — on the surface a reader consults precisely
// when a run has failed.
// ---------------------------------------------------------------------------------------------

console.log('\nThe app can read what the bundle decided');

/*
 * Comments stripped, because both checks below match text and both files are mostly prose.
 *
 * `settings.includes('max_retries')` was true of a file that merely discussed the field, which is why the
 * field check now matches a declaration — but a declaration inside a comment satisfies that too, and I
 * confirmed the check passed with the real one replaced by `// was: readonly max_retries?: number;`. The
 * residual was caught by `typecheck`, which is the wrong check reporting the wrong thing. Same hole for the
 * `ASSESS_TASK` constant, where a comment quoting it satisfies the count.
 */
function bare(path) {
  return readFileSync(path, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');
}

const reader = bare(join(APP, 'server', 'schedule', 'schedule.ts'));
const settings = bare(join(APP, 'server', 'schedule', 'port.ts'));

/*
 * The count is asserted, not just the value, and that is the whole difference between this check and a
 * decoration. `[].every()` is `true`, so the first version of this passed on a tree where `ASSESS_TASK`
 * had been deleted and `'assess'` inlined at the one call site — the exact drift a grep for a constant is
 * there to catch, reported as ok. A check that passes vacuously is worse than no check, because it is
 * trusted.
 */
const keys = [...reader.matchAll(/ASSESS_TASK\s*=\s*'([^']+)'/g)].map((one) => one[1]);

check(
  'the task whose retry policy the app reports is one this job has',
  keys.length === 1 && taskNamed(keys[0]) !== undefined,
  keys.length === 1
    ? `server/schedule/schedule.ts looks for a task named '${keys[0]}', which ${JOB} does not have, so the ` +
      `panel would stop reporting retries entirely. Its tasks are ${job.tasks.map((one) => one.task_key).join(', ')}.`
    : `server/schedule/schedule.ts should declare exactly one ASSESS_TASK constant and declares ${String(keys.length)}. ` +
      'This check reads that constant to compare it with the bundle, and cannot do so if it is inlined or duplicated.'
);

for (const [field, where] of [
  ['max_retries', task],
  ['min_retry_interval_millis', task],
  ['retry_on_timeout', task],
  ['email_notifications', job],
]) {
  /*
   * Genuinely both directions, which the first version of this claimed and did not do. A field the job
   * sets and the port does not declare is invisible to the app, because the SDK hands over only what the
   * type asks for — so the panel would go on describing a policy that had changed underneath it. And a
   * field the port declares that the job no longer sets is a surface quietly gone blank: the payload
   * omits it, the sentence drops a clause, and nothing says why.
   *
   * The declaration is matched rather than the file text. `settings.includes('max_retries')` was true of
   * a file that merely discussed `max_retries` in a comment, and this file carries more prose than code.
   */
  // `\??` so a field declared as required is read as declared. It was `\?:`, which failed the check with a
  // message saying the port did not declare a field it declared — true drift reported as the wrong problem.
  const declared = new RegExp(`readonly ${field}\\??:`).test(settings);
  const set = where[field] !== undefined;

  check(
    `the app's port and this job agree on ${field}`,
    declared === set,
    set
      ? `${JOB} sets ${field} and server/schedule/port.ts does not declare it, so the app cannot see it. ` +
        'The panel would report the schedule as unsupervised on a job that is supervised.'
      : `server/schedule/port.ts declares ${field} and ${JOB} no longer sets it, so the panel has quietly ` +
        'stopped saying what the job does about a failure. Remove the field or restore the setting.'
  );
}

// ---------------------------------------------------------------------------------------------
// The scheduled run answers to the assessment the job names
//
// GAP-036 asks that scheduled work carry an immutable target and report it. Immutable means an id in
// the job definition: a job that asked the app for "the newest assessment" when it fired would answer
// to a different one the moment somebody defined one, and the trend it feeds would step for a reason
// nothing recorded.
//
// Three files have to agree for that to hold, and none of them typechecks against the others. The job
// sets a parameter, the notebook reads a widget of the same name and sends it as a field the route
// accepts, and the app reads the same parameter back off the job to say which assessment the schedule
// answers to. A rename in one place is silent in the worst direction: the parameter reads back as its
// default, so the job answers to no assessment while the panel goes on reporting whichever half of the
// pair still matches.
// ---------------------------------------------------------------------------------------------

console.log('\nThe scheduled run answers to the assessment the job names');

/** The parameter name, read from the app so the two sides are compared rather than both assumed. */
const named = [...reader.matchAll(/ASSESSMENT_PARAMETER\s*=\s*'([^']+)'/g)].map((one) => one[1]);

check(
  'the app reads the assessment from one named parameter',
  named.length === 1,
  `server/schedule/schedule.ts should declare exactly one ASSESSMENT_PARAMETER constant and declares ${String(named.length)}. ` +
    'This check reads that constant to compare it with the bundle, and cannot do so if it is inlined or duplicated.'
);

check(
  'the assess task sets that parameter, so a scheduled run has a target to carry',
  named.length === 1 && parameters[named[0]] !== undefined,
  named.length === 1
    ? `${JOB} must set ${named[0]} on the assess task. Without it the app reports a job that names no ` +
      'assessment, every scheduled run is recorded outside every assessment, and nothing says so — which ' +
      'is the position GAP-036 was raised about.'
    : 'The parameter the app reads could not be determined, so this could not be checked.'
);

check(
  'and sets it from a bundle variable, so naming one is a deploy rather than an edit',
  named.length === 1 && /^\$\{var\./.test(parameters[named[0]] ?? ''),
  `${JOB} must set ${named[0] ?? 'the assessment parameter'} from a bundle variable. A literal id here is ` +
    'one every install shares and nobody can override without editing the file this bundle ships.'
);

check(
  'the notebook reads that widget and sends it as the field the route accepts',
  named.length === 1 && new RegExp(`"${named[0]}"`).test(code) && /"definitionId"/.test(code),
  `The notebook must read the ${named[0] ?? 'assessment'} widget and post it as definitionId. The route ` +
    'takes the assessment under that name and under no other; a body without it starts a run that answers ' +
    'to nothing, which is what this job did before the parameter existed.'
);

/*
 * The one body the route refuses outright, and it is refused for a reason worth keeping: an assessment
 * says which pillars, which workspaces and how far back, so a run stamped with its fingerprint while
 * measuring some other window would be recorded as having asked a question nobody asked. `askedFor` in
 * `server/api/routes.ts` returns `assessment-and-overrides` for it, and the whole scheduled run fails.
 *
 * Matched per dict literal rather than per file, because the notebook legitimately names both — it sends
 * one or the other depending on whether an assessment is named.
 */
const bothInOneBody = /\{[^{}]*"definitionId"[^{}]*"lookbackDays"[^{}]*\}|\{[^{}]*"lookbackDays"[^{}]*"definitionId"[^{}]*\}/.test(
  code
);

check(
  'and never sends the window alongside it, which the route refuses',
  !bothInOneBody,
  'The notebook posts definitionId and lookbackDays in one body. The route refuses that with ' +
    'assessment-and-overrides, because the assessment already says how far back to look — so every ' +
    'scheduled run would fail on a 400. Send one or the other.'
);

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} problem${failures.length === 1 ? '' : 's'}:\n`);
  for (const failure of failures) console.error(`  * ${failure}\n`);
  process.exit(1);
}

console.log('\nThe job supervises and the app executes, on both sides of the split.');
