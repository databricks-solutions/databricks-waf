// The one path that reaches `verified`.
//
// ADR 0051 made the state unreachable by a person and named a run as the only thing that could reach
// it. ADR 0053 made "a run" specific: an attempt somebody asked for, answered by a run allowed to
// answer it. This is where the two meet, and it is the only caller of `verifiedBy` in the app.
//
// It runs after a scan is saved rather than as part of producing one, because it is a different kind
// of work: a scan measures the estate, and this reads what was measured against questions asked
// earlier. Failing here must not fail the scan — the findings are real and worth keeping whatever
// happens to the validations — so nothing throws out of `resolveValidations`, and what it could not do
// is reported and returned rather than raised.
//
// Three readings of a run are refused here, and each one is a way this could have quietly verified
// work that was not done.
//
// **A carried-forward pillar has not been measured by this run.** A targeted rerun of one pillar
// produces a scan carrying the other six from last Tuesday, and those findings are last Tuesday's
// answer. Reading them as this run's would let a rerun of an unrelated pillar verify a claim, which is
// the failure ADR 0053 exists to stop wearing different clothes.
//
// **A claim that has moved on is not the claim the attempt is about.** An owner who took the work back
// to `in-progress`, or offered it again after more work, has made the outstanding attempt a question
// about something that is no longer true. The attempt is closed as incomplete rather than answered.
//
// **An answer that arrives second is somebody else's answer.** Two instances of the app both notice
// the same finished scan; the store refuses the second write, and the second instance treats that as a
// success belonging to the other one rather than as an error to report.

import { verifiedBy, type ImprovementAction } from '../improve/action.js';
import { ConcurrentChangeError, type ImprovementStore } from '../improve/store.js';
import type { Finding } from '../resolve/finding.js';
import type { Scan } from '../scan/scan.js';
import {
  abandoned,
  answerable,
  answeredBy,
  claimedAtOf,
  verifies,
  type Observation,
  type ValidationAttempt,
} from './attempt.js';
import { AlreadyAnsweredError, type ValidationStore } from './store.js';

export interface ResolveOptions {
  readonly validations: ValidationStore;
  /**
   * Where the actions are, because reaching `verified` is a write to one.
   *
   * Required rather than optional: a resolution pass without it would answer every attempt and leave
   * every action in `ready-for-validation`, which is a validation record nobody could see the effect
   * of and a board that never moves.
   */
  readonly improvements: ImprovementStore;
  readonly onError?: (operation: string, error: unknown) => void;
}

/**
 * What one pass did, for the caller's log and for tests.
 *
 * Counted rather than returned as records, because the caller is a scan-completion path that has no
 * use for an attempt and every reason not to hold one. `verified` is the number a reader of a log
 * actually wants: it is how many claims this run settled.
 */
export interface Resolution {
  readonly answered: number;
  readonly verified: number;
  readonly failed: number;
  readonly incomplete: number;
  /**
   * Attempts that passed and whose action could not be marked verified.
   *
   * Its own number rather than folded into `verified` or dropped, so that `answered` always equals the
   * four outcomes added up. Without it a pass whose write lost a race would be counted as answered and
   * as nothing else, and a log line that does not add up is one nobody trusts the rest of.
   *
   * Worth acting on: the attempt says the work holds and the board still shows it as claimed, and the
   * way out is to ask for another validation.
   */
  readonly stalled: number;
  /** Attempts closed because the claim they were about had gone. */
  readonly withdrawn: number;
  /** Attempts this run was not allowed or not able to answer, which stay outstanding. */
  readonly waiting: number;
}

const NOTHING: Resolution = {
  answered: 0,
  verified: 0,
  failed: 0,
  incomplete: 0,
  stalled: 0,
  withdrawn: 0,
  waiting: 0,
};

/** Why an attempt with no requirements under it is closed instead of answered. Read by whoever asked. */
const NOTHING_TO_CHECK =
  'This validation names no requirement, so no run can say whether the work landed. It is closed rather ' +
  'than left waiting for a run that could never answer it. An action raised from advisor advice is ' +
  'settled by the advisor reading the estate again, not by an assessment.';

/**
 * Answers every outstanding validation this run may answer, and verifies what passed.
 *
 * Never rejects. A pass that cannot read the attempts answers none of them, and the next run answers
 * them instead — late, which is the right way for this to fail.
 */
export async function resolveValidations(scan: Scan, options: ResolveOptions): Promise<Resolution> {
  let outstanding: readonly ValidationAttempt[];
  try {
    outstanding = await options.validations.outstanding();
  } catch (error) {
    options.onError?.('read the validations waiting on a run', error);
    return NOTHING;
  }
  if (outstanding.length === 0) return NOTHING;

  const measured = measuredHere(scan);
  const findings = new Map(scan.findings.map((finding) => [finding.controlId, finding]));
  const tally = { ...NOTHING };

  for (const attempt of outstanding) {
    try {
      const one = await settle(attempt, scan, { measured, findings }, options);
      tally.answered += one.answered;
      tally.verified += one.verified;
      tally.failed += one.failed;
      tally.incomplete += one.incomplete;
      tally.stalled += one.stalled;
      tally.withdrawn += one.withdrawn;
      tally.waiting += one.waiting;
    } catch (error) {
      // Per attempt rather than per pass, so one attempt whose action cannot be read does not cost
      // the others their answer.
      options.onError?.(`answer validation ${attempt.id}`, error);
      tally.waiting += 1;
    }
  }

  return tally;
}

interface RunView {
  /** The pillars this run measured itself, so a carried-forward finding can be told from a fresh one. */
  readonly measured: ReadonlySet<string>;
  readonly findings: ReadonlyMap<string, Finding>;
}

async function settle(
  attempt: ValidationAttempt,
  scan: Scan,
  run: RunView,
  options: ResolveOptions
): Promise<Resolution> {
  if (!answerable(attempt, { measuredAt: scan.finishedAt })) return { ...NOTHING, waiting: 1 };

  const scope = scan.stamp.definition?.id ?? null;
  const action = await options.improvements.action(attempt.actionId, scope);
  const gone = whyGone(attempt, action);
  if (gone != null) {
    await options.validations.answer(abandoned(attempt, gone, scan.finishedAt));
    return { ...NOTHING, withdrawn: 1 };
  }

  if (attempt.checks.length === 0) {
    // Closed rather than answered, and closed rather than left alone. `answeredBy` refuses an attempt
    // with nothing to measure — an empty set is met by every run, so the answer would be a pass — and
    // an attempt this pass cannot answer and does not close is one every later run picks up, fails on
    // and reports again. Nothing this app writes produces one: `draftFrom` refuses an action naming no
    // requirement, which is what an action raised from advice is.
    await options.validations.answer(abandoned(attempt, NOTHING_TO_CHECK, scan.finishedAt));
    return { ...NOTHING, withdrawn: 1 };
  }

  // Every requirement in the attempt has to have been measured by this run. A partly carried-forward
  // answer is not this run's reading, and an attempt half-answered by two runs is an attempt whose
  // result belongs to neither.
  const stale = attempt.checks.filter((check) => !freshlyMeasured(check.controlId, run));
  if (stale.length > 0) return { ...NOTHING, waiting: 1 };

  const answered = answeredBy(attempt, {
    scanId: scan.id,
    measuredAt: scan.finishedAt,
    observations: attempt.checks.map((check) => observationOf(check.controlId, run)),
  });

  try {
    await options.validations.answer(answered);
  } catch (error) {
    // Somebody else's success. Nothing to report and nothing to do: the action they verified is the
    // same action this pass would have verified, from the same run.
    if (error instanceof AlreadyAnsweredError) return { ...NOTHING, waiting: 1 };
    throw error;
  }

  const result = answered.answer?.result;
  if (!verifies(answered)) {
    return { ...NOTHING, answered: 1, failed: result === 'failed' ? 1 : 0, incomplete: result === 'failed' ? 0 : 1 };
  }

  // Non-null: `whyGone` refused an absent action above.
  const verified = await verify(action as ImprovementAction, scan, options);
  return { ...NOTHING, answered: 1, ...(verified ? { verified: 1 } : { stalled: 1 }) };
}

/**
 * Why the claim this attempt was about is no longer there, or undefined while it is.
 *
 * Prose rather than a code, because it is stored as the reason the attempt was closed and read by
 * somebody wondering why their validation never produced an answer. "The action was moved to
 * in-progress" is that answer; `claim-withdrawn` is a thing they then have to ask about.
 */
function whyGone(attempt: ValidationAttempt, action: ImprovementAction | undefined): string | undefined {
  if (action == null) {
    return (
      'The action this validation was about is no longer in the record, so nothing can be validated. ' +
      'This closes the attempt rather than leaving it waiting on a run that could never answer it.'
    );
  }
  if (action.state !== 'ready-for-validation') {
    return (
      `The claim this validation was checking was withdrawn: the action is ${action.state}. Offer the ` +
      'work for validation again when it is done, and the next run will answer that claim.'
    );
  }

  const claimed = claimedAtOf(action);
  if (claimed == null || claimed.getTime() !== attempt.claimedAt.getTime()) {
    return (
      'The work was taken back and claimed done again after this validation was asked for, so this ' +
      'attempt is about the earlier claim. Ask for a validation of the new one.'
    );
  }
  return undefined;
}

/**
 * Marks the action verified by this run, retrying once if somebody wrote the action meanwhile.
 *
 * Once rather than in a loop: the writer it is racing is a person moving the action by hand, and a
 * second read either finds an action still ready for validation — in which case the retry works — or
 * one that has moved on, in which case no number of retries helps and `whyGone` on the next pass is
 * the honest answer.
 *
 * Reports rather than raises, and returns whether it verified. The answer is already on the record by
 * the time this runs, so an exception out of here would be caught by the pass as a failure to answer —
 * naming the wrong operation and losing an answer that was in fact written. False leaves an action in
 * `ready-for-validation` with a passed attempt behind it, which is visible rather than silent: the
 * attempt says it passed, `stalled` counts it, and the way out is to ask for another validation, which
 * is permitted because nothing is outstanding.
 */
async function verify(action: ImprovementAction, scan: Scan, options: ResolveOptions): Promise<boolean> {
  for (const remaining of [1, 0]) {
    try {
      const current = remaining === 1 ? action : await options.improvements.action(action.id, scan.stamp.definition?.id ?? null);
      // Somebody moved it between the answer and this write. Their move is the newer fact about the
      // action, and the passed attempt beside it is the record of what this run found.
      if (current == null || current.state !== 'ready-for-validation') return false;

      const plan = await options.improvements.plan(current.planId);
      if (plan == null) {
        // The action is there and its plan is not, which nothing in the app produces. Reported rather
        // than worked around, because inventing a plan to satisfy a store signature would write an
        // action into a plan that does not exist.
        options.onError?.(
          `verify action ${current.id}`,
          new Error(`Action ${current.id} names plan ${current.planId}, which is not in the record.`)
        );
        return false;
      }

      await options.improvements.changeAction(verifiedBy(current, scan.id, scan.finishedAt), plan);
      return true;
    } catch (error) {
      if (error instanceof ConcurrentChangeError && remaining > 0) continue;
      options.onError?.(`verify action ${action.id}`, error);
      return false;
    }
  }
  return false;
}

/** The pillars this run measured itself. A pillar it carried forward is not among them. */
function measuredHere(scan: Scan): ReadonlySet<string> {
  return new Set(
    scan.measurement.filter((pillar) => !pillar.carriedForward).map((pillar) => pillar.pillarId)
  );
}

function freshlyMeasured(controlId: string, run: RunView): boolean {
  const finding = run.findings.get(controlId);
  // A requirement with no finding at all counts as measured, so the attempt is answered as
  // `incomplete` rather than waiting for ever. The two are different absences: a requirement whose
  // pillar was carried forward will be measured by a later run, and one this build produced no
  // finding for will not be.
  return finding == null || run.measured.has(finding.pillarId);
}

/**
 * What this run says about one requirement, in the terms the attempt reads.
 *
 * `attestedAt` is carried only where the answer decided the outcome. An answer recorded beside a
 * measurement is not what the finding rests on, and passing its date would fail a validation for the
 * age of evidence that did not decide anything.
 */
function observationOf(controlId: string, run: RunView): Observation {
  const finding = run.findings.get(controlId);
  if (finding == null) return { controlId };

  return {
    controlId,
    outcome: finding.outcome,
    ...(finding.attested?.bearing === 'outcome' ? { attestedAt: finding.attested.at } : {}),
  };
}
