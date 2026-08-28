// The words the checks page puts around the plan's numbers.
//
// Separated from the page because these are the part that can be wrong without failing to
// render: a coverage sentence that double-counts blocked checks, or a cost sentence that
// omits the per-object part, reads perfectly and misleads. Tested in checks-language.test.ts.

import { counts, inPillar } from './attest-language';
import type { AttestableRequirement, PillarPlan, PlannedSignal, Requirement, SurfaceCost } from '../api/types';

export const REQUIREMENT_LABEL: Readonly<Record<Requirement['kind'], string>> = {
  'metastore-grant': 'Unity Catalog grant',
  'workspace-permission': 'Workspace permission',
  'app-scope': 'App authorisation scope',
};

const REACH_PHRASE: Readonly<Record<PlannedSignal['reach'], string>> = {
  account: 'every workspace in the account',
  metastore: "this workspace's metastore region",
  workspace: 'this workspace only',
};

export function reachPhrase(reach: PlannedSignal['reach']): string {
  return `Covers ${REACH_PHRASE[reach]}`;
}

const SURFACE_NAME: Readonly<Record<string, string>> = {
  sql: 'System table queries',
  describe: 'Per-object metadata',
  rest: 'Workspace configuration calls',
  cloud: 'Cloud provider calls',
  ai: 'Model serving calls',
  plans: 'Query plan lookups',
};

export function surfaceName(surface: string): string {
  return SURFACE_NAME[surface] ?? surface;
}

/** Which of a check's three relationships to a requirement a part counts, as the findings page reads it. */
export type ServesRole = 'decides' | 'scopes' | 'details';

export interface ServesPart {
  /** Absent where the part is prose about the check rather than a count of requirements. */
  readonly role?: ServesRole;
  readonly label: string;
}

/**
 * What reads this signal, in parts, because each count is a set of requirements to open.
 *
 * "decides 6" was a sentence for months, and the reader who wanted the six had nowhere to go: the
 * only way to find them was to read 184 rows on the findings page looking for the ones this check
 * happens to answer. The three relationships stay separate rather than being summed, because they
 * are not the same list — a requirement a check scopes takes its outcome from somewhere else, and a
 * total spanning all three would be a number the reader could click and not recognise.
 *
 * An input that nothing reads directly still has to be collected, and saying so is the
 * difference between a reader thinking the app runs a pointless statement and understanding
 * that a sample has to be chosen before it can be described.
 */
export function serves(signal: PlannedSignal): readonly ServesPart[] {
  if (signal.input) return [{ label: 'Collected because other checks need it' }];

  const counted: readonly (readonly [ServesRole, readonly string[]])[] = [
    ['decides', signal.answers],
    ['scopes', signal.gates],
    ['details', signal.enriches],
  ];
  const parts: ServesPart[] = counted
    .filter(([, requirements]) => requirements.length > 0)
    .map(([role, requirements]) => ({
      role,
      label: `${role} ${String(requirements.length)} ${requirements.length === 1 ? 'requirement' : 'requirements'}`,
    }));

  return parts.length === 0 ? [{ label: 'Collected but read by nothing' }] : parts;
}

export function costPhrase(signal: PlannedSignal): string {
  switch (signal.cost.kind) {
    case 'one-statement':
      return 'One statement';
    case 'one-call':
      return 'One API call';
    case 'per-object':
      return signal.cost.ceiling != null
        ? `One statement per ${signal.cost.objects ?? 'object'}, up to ${String(signal.cost.ceiling)}`
        : `One statement per ${signal.cost.objects ?? 'object'}`;
  }
}

/**
 * The denominator, in the same shape the pillar page uses.
 *
 * Blocked checks are counted apart from unbuilt ones because they are the opposite problem:
 * the check exists and is written, and the platform will not authorise this app to run it.
 * Folding them into "no check yet" would leave the reader waiting for something that shipped.
 */
export function coverageSentence(pillar: PillarPlan): string {
  const { answeredControls: answered, blockedControls: blocked, totalControls: total, unanswered } = pillar;
  const runnable = answered - blocked;

  const parts = [`${String(runnable)} of ${String(total)} requirements are decided by the checks below`];
  if (blocked > 0) {
    parts.push(
      `${String(blocked)} more have a check that no install of this app can be authorised to run, so they need your attestation instead`
    );
  }

  const rest = [
    unanswered.attestation > 0
      ? `${String(unanswered.attestation)} are practice statements only you can answer`
      : undefined,
    // Worded as a limit rather than as a gap, because that is what it is, and the reader's next
    // move differs: there is nothing to wait for here and the answer has to come from them.
    unanswered.unreachable > 0
      ? `${String(unanswered.unreachable)} are settings this app is not authorised to read, so they need your answer too`
      : undefined,
    unanswered.planned > 0 ? `${String(unanswered.planned)} have a check planned but not built` : undefined,
    unanswered.unimplemented > 0 ? `${String(unanswered.unimplemented)} have no check and none planned` : undefined,
  ].filter((part): part is string => part != null);
  if (rest.length > 0) parts.push(rest.join(', '));

  return `${parts.join('. ')}.`;
}

export interface AnswerCall {
  /** The rows the answers page lists for this pillar. What the link lands on. */
  readonly total: number;
  /** Of those, the ones whose answer is not counting toward the score today. */
  readonly outstanding: number;
  readonly label: string;
}

/**
 * The offer to go and answer this pillar's requirements, counted from the page it lands on.
 *
 * Counted from `/api/attestations` and not from the plan, which is the defect this replaced. The
 * link said `unanswered.attestation + blockedControls` — 23 on the security pillar, where the page
 * it opened listed 47 — because the plan splits out-of-reach requirements into two buckets and this
 * summed one of them. Adding the other does not fix it either: the plan is derived from the
 * catalogue and cached for the process, and what the answers page asks depends on the last run, which
 * drops a blocked setting an evidence import has since measured and adds the ones a check ran on and
 * could not decide. So the number comes from the set rather than from arithmetic over its parts, and
 * `inPillar` is the answers page's own filter rather than a second copy of it.
 *
 * Both numbers are said where they differ, because neither alone is the sentence: the total is what
 * the reader will see on arrival, and the outstanding count is the work. Absent, rather than zero,
 * for a pillar the page has nothing to show for — including while the request is in flight, where a
 * link promising a number this app has not read yet would be the same fault in a smaller form.
 */
export function answerCall(requirements: readonly AttestableRequirement[], pillarId: string): AnswerCall | null {
  const asked = requirements.filter((one) => inPillar(one, pillarId));
  if (asked.length === 0) return null;

  const total = asked.length;
  const outstanding = total - asked.filter(counts).length;
  const noun = total === 1 ? 'requirement' : 'requirements';

  if (outstanding === 0) {
    // "All 1 requirement ... are answered" agrees with nothing. The determiner goes with the verb.
    const label =
      total === 1
        ? 'The 1 requirement no check decides is answered'
        : `All ${String(total)} ${noun} no check decides are answered`;
    return { total, outstanding, label };
  }
  if (outstanding === total) {
    return { total, outstanding, label: `Answer the ${String(total)} ${noun} no check decides` };
  }
  return {
    total,
    outstanding,
    label: `Answer ${String(outstanding)} of the ${String(total)} ${noun} no check decides`,
  };
}

/**
 * The cost as a count, for a control's own label.
 *
 * The fixed statements only. A per-object cost has no single number before the objects are counted,
 * and "8–258 queries" in a button label is worse than the honest floor with the full sentence one
 * hover away — which is what costSentence is for.
 */
export function costCount(costs: readonly SurfaceCost[]): string {
  const fixed = costs.reduce((sum, cost) => sum + cost.fixed, 0);
  const variable = costs.some((cost) => cost.variable.length > 0);
  if (fixed === 0) return variable ? 'scaled to your estate' : 'no queries';
  return `${String(fixed)}${variable ? '+' : ''} ${fixed === 1 && !variable ? 'query' : 'queries'}`;
}

/** Cost per surface, with the per-object part stated separately from the fixed statements. */
export function costSentence(costs: readonly SurfaceCost[]): string {
  if (costs.length === 0) return 'A run for this pillar executes nothing.';

  return costs
    .map((cost) => {
      const parts: string[] = [];
      if (cost.fixed > 0) {
        parts.push(`${String(cost.fixed)} ${cost.fixed === 1 ? 'statement' : 'statements'}`);
      }
      for (const variable of cost.variable) {
        parts.push(
          variable.ceiling != null
            ? `one per ${variable.objects} (up to ${String(variable.ceiling)})`
            : `one per ${variable.objects}`
        );
      }
      const executed = parts.length === 0 ? 'nothing' : parts.join(', plus ');
      return `${surfaceName(cost.surface)}: ${executed}, within a budget of ${String(cost.budget)}.`;
    })
    .join(' ');
}
