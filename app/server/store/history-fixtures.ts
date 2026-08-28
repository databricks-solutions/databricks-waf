// Records shaped like the ones a customer's install accumulates, for the history-read benchmark.
//
// The measurement these feed is only worth its apparatus, and `scale.ts` is the worked example of that
// going wrong: the first pass at H1 measured a statement with a fixture one column narrower than the
// statement's own `SELECT`, and produced a real, reproducible number about a query that does not exist.
// The equivalent mistake here is a record narrower than the record the app writes — an attestation with
// no `evidenceUrl`, an action with an empty `history` — because every read in the budget pays for the
// whole `jsonb` body and a thin body makes the read look cheap.
//
// So two rules, and `history-fixtures.test.ts` enforces the first of them against the type declarations
// themselves rather than against a list kept here:
//
//   **Every field the record's interface declares is populated**, optional ones included. A field left
//   out is bytes the benchmark does not pay for and the app does.
//
//   **Widths come from what the field holds when a person fills it in**, not from what is convenient.
//   `reason` and `compensatingControl` are refused below 20 characters by their own validators and are
//   two or three sentences in practice; an owner is a Databricks identity, which is an email address;
//   `definitionOfDone` is the longest prose in the schema. A record of `x` in every field would measure
//   the row count precisely and the byte count not at all.
//
// One field is deliberately absent and it is the exception that has to be stated rather than noticed.
// An action raised from advisor advice carries an `advice` provenance block — the advisory, the rule,
// its versions, the resource, the evidence the rule fired on — and these fixtures carry none, so the
// action bodies are those of a requirement-raised action. `history-fixtures.test.ts` holds the
// exemption with that reason attached, and the published table says so beside the number, because an
// install whose actions came from the advisor holds more per revision than this measures.
//
// What these are not: they are not built through the domain's own factories. The factories read the
// store before each write — `registerAttestation` reads `current` to name what it supersedes — so
// seeding ten thousand records through them is quadratic and would take longer than the measurement.
// They are built to the shape the route writes, and held to the interface by the test.

import { randomUUID } from 'node:crypto';
import type { Attestation } from '../attest/attestation.js';
import { reviewDateFrom, cadenceDaysFor, DAY_MS } from '../attest/attestation.js';
import type { ApplicabilityDecision } from '../apply/applicability.js';
import type { AcceptedRisk } from '../accept/risk.js';
import type { AssessmentDefinition, DefinitionVersion } from '../define/definition.js';
import { fingerprintOf } from '../define/definition.js';
import type { ImprovementAction, Transition } from '../improve/action.js';
import type { ImprovementPlan } from '../improve/plan.js';
import type { Note } from '../note/note.js';
import type { AttemptCheck, ValidationAttempt } from '../validate/attempt.js';

/**
 * Prose of a stated length, in words rather than in a repeated character.
 *
 * `jsonb` stores the text and `JSON.parse` walks it, and both are sensitive to length rather than to
 * content — but a single repeated character is compressible in a way real prose is not, and TOAST
 * compresses the column above two kilobytes. So the filler is words.
 */
function prose(length: number, seed: number): string {
  const words = [
    'the',
    'requirement',
    'is',
    'answered',
    'by',
    'a',
    'quarterly',
    'review',
    'that',
    'platform',
    'engineering',
    'runs',
    'against',
    'the',
    'production',
    'workspaces',
    'and',
    'records',
    'in',
    'confluence',
    'with',
    'the',
    'run',
    'attached',
  ];
  let text = '';
  let index = seed;
  while (text.length < length) {
    text += `${words[index % words.length] ?? 'and'} `;
    index += 1;
  }
  return text.slice(0, length).trim();
}

/** A Databricks identity, which is what every owner field in this schema holds. */
function owner(seed: number): string {
  return `${['priya.raman', 'j.okonkwo', 'data-platform-oncall', 'm.svensson', 'governance-council'][seed % 5] ?? 'owner'}@example.com`;
}

function url(seed: number): string {
  return `https://example.atlassian.net/wiki/spaces/PLATFORM/pages/${String(490_000 + seed)}/control-evidence`;
}

/** Requirement ids in the catalogue's own shape, so a control id is the width it really is. */
export function requirementIds(count: number): readonly string[] {
  const pillars = ['SEC', 'REL', 'COST', 'OPS', 'PERF', 'GOV', 'AI'];
  return Array.from({ length: count }, (_, index) => {
    const pillar = pillars[index % pillars.length] ?? 'SEC';
    return `${pillar}-${String(Math.floor(index / pillars.length) + 1).padStart(3, '0')}-${['access', 'encryption', 'lineage', 'quota', 'backup'][index % 5] ?? 'control'}`;
  });
}

const START = new Date('2019-01-07T09:00:00.000Z');

/** `revision` renewals of one requirement's answer, oldest first, each superseding the last. */
export function attestations(controlId: string, revisions: number, seed: number): readonly Attestation[] {
  const built: Attestation[] = [];
  let previous: string | undefined;
  for (let index = 0; index < revisions; index += 1) {
    const at = new Date(START.getTime() + (seed + index) * 90 * DAY_MS);
    const id = randomUUID();
    built.push({
      id,
      controlId,
      answer: (['met', 'partially-met', 'not-met', 'not-applicable'] as const)[(seed + index) % 4] ?? 'met',
      statement: prose(320, seed + index),
      evidenceUrl: url(seed + index),
      owner: owner(seed),
      attestedBy: owner(seed + 1),
      attestedAt: at,
      reviewBy: reviewDateFrom(at, cadenceDaysFor('critical')),
      ...(previous != null ? { supersedes: previous } : {}),
      definitionId: `assessment-${String(seed % 12)}`,
    });
    previous = id;
  }
  return built;
}

/** `revisions` decisions on one requirement, each renewing the one before it. */
export function decisions(controlId: string, revisions: number, seed: number): readonly ApplicabilityDecision[] {
  const built: ApplicabilityDecision[] = [];
  let previous: string | undefined;
  for (let index = 0; index < revisions; index += 1) {
    const from = new Date(START.getTime() + (seed + index) * 90 * DAY_MS);
    const id = randomUUID();
    built.push({
      id,
      controlId,
      lever: (['not-applicable', 'disabled'] as const)[(seed + index) % 2] ?? 'not-applicable',
      ordinal: index + 1,
      reason: prose(280, seed + index),
      owner: owner(seed),
      effectiveFrom: from,
      expiresAt: new Date(from.getTime() + 90 * DAY_MS),
      recordedBy: owner(seed + 2),
      recordedAt: from,
      ...(previous != null ? { supersedes: previous } : {}),
      // Every third one was ended early, so the body carries the revocation a live register holds.
      ...((seed + index) % 3 === 0
        ? { revoked: { by: owner(seed + 3), at: new Date(from.getTime() + 30 * DAY_MS), reason: prose(140, seed) } }
        : {}),
      definitionId: `assessment-${String(seed % 12)}`,
    });
    previous = id;
  }
  return built;
}

/** `revisions` acceptances of one requirement, each renewing the one before it. */
export function risks(controlId: string, revisions: number, seed: number): readonly AcceptedRisk[] {
  const built: AcceptedRisk[] = [];
  let previous: string | undefined;
  for (let index = 0; index < revisions; index += 1) {
    const from = new Date(START.getTime() + (seed + index) * 90 * DAY_MS);
    const id = randomUUID();
    built.push({
      id,
      controlId,
      ordinal: index + 1,
      reason: prose(300, seed + index),
      compensatingControl: prose(340, seed + index + 7),
      residual: (['critical', 'high', 'medium', 'low', 'informational'] as const)[(seed + index) % 5] ?? 'medium',
      owner: owner(seed),
      effectiveFrom: from,
      expiresAt: new Date(from.getTime() + 90 * DAY_MS),
      recordedBy: owner(seed + 2),
      recordedAt: from,
      ...(previous != null ? { supersedes: previous } : {}),
      ...((seed + index) % 3 === 0
        ? { revoked: { by: owner(seed + 3), at: new Date(from.getTime() + 30 * DAY_MS), reason: prose(150, seed) } }
        : {}),
      definitionId: `assessment-${String(seed % 12)}`,
    });
    previous = id;
  }
  return built;
}

/** One assessment definition with `revisions` versions, which is what the versions table holds. */
export function definition(id: string, revisions: number, seed: number, pillars: readonly string[]): AssessmentDefinition {
  const versions: DefinitionVersion[] = [];
  for (let index = 0; index < revisions; index += 1) {
    const createdAt = new Date(START.getTime() + (seed + index) * 30 * DAY_MS);
    const measurement = {
      scope:
        (seed + index) % 2 === 0
          ? ({ kind: 'account' } as const)
          : ({
              kind: 'selected',
              workspaceIds: Array.from({ length: 24 }, (_, w) => String(1_234_567_890_123_456n + BigInt(w))),
            } as const),
      lookbackDays: 30 + ((seed + index) % 60),
      pillars: pillars.slice(0, 4 + ((seed + index) % 3)),
    };
    versions.push({
      version: index + 1,
      fingerprint: fingerprintOf(measurement),
      createdAt,
      createdBy: owner(seed),
      measurement,
      attribution: {
        name: `${['Group risk', 'Platform', 'Regulated data', 'Analytics'][seed % 4] ?? 'Platform'} assessment ${String(seed)}`,
        purpose: prose(220, seed + index),
        owners: [owner(seed), owner(seed + 1), owner(seed + 2)],
      },
      targets: pillars.map((pillar, at) => ({
        pillar,
        atLeast: 60 + ((seed + at) % 35),
        by: new Date(createdAt.getTime() + (90 + at * 30) * DAY_MS),
      })),
      // Absent on the first version, which changed nothing — the field's own rule.
      ...(index === 0 ? {} : { note: prose(180, seed + index) }),
    });
  }
  return { id, versions, ...(seed % 7 === 0 ? { archivedAt: new Date(START.getTime() + 900 * DAY_MS) } : {}) };
}

export function plan(id: string, seed: number): ImprovementPlan {
  return {
    id,
    title: `${['Regulated data remediation', 'Cost programme', 'Reliability hardening'][seed % 3] ?? 'Programme'} ${String(seed)}`,
    outcome: prose(260, seed),
    owners: [owner(seed), owner(seed + 1)],
    assessment: { definitionId: `assessment-${String(seed % 12)}`, version: 1 + (seed % 9) },
    raisedFrom: randomUUID(),
    createdBy: owner(seed),
    createdAt: new Date(START.getTime() + seed * 30 * DAY_MS),
    ...(seed % 4 === 0
      ? { closed: { at: new Date(START.getTime() + (seed * 30 + 200) * DAY_MS), by: owner(seed), reason: prose(120, seed) } }
      : {}),
    revision: 0,
  };
}

/**
 * `revisions` revisions of one action, oldest first, each carrying the history it had accrued.
 *
 * The history is what makes an action's body grow, and it is the field a thin fixture omits: an action
 * revised eight times carries eight transitions, each with its own prose, and the read that loads every
 * revision of every action loads every one of those bodies.
 */
export function actions(
  planId: string,
  controlIds: readonly string[],
  revisions: number,
  seed: number,
): readonly ImprovementAction[] {
  const id = randomUUID();
  const states = ['draft', 'planned', 'in-progress', 'blocked', 'ready-for-validation', 'verified'] as const;
  const built: ImprovementAction[] = [];
  const history: Transition[] = [];

  for (let index = 0; index < revisions; index += 1) {
    const at = new Date(START.getTime() + (seed + index) * 21 * DAY_MS);
    const state = states[index % states.length] ?? 'planned';
    if (index > 0) {
      history.push({
        from: states[(index - 1) % states.length] ?? 'draft',
        to: state,
        at,
        // `person` rather than `run` for every move here, which is the cheaper body of the two: a
        // measurement's transition carries the run id in `who` as well, and the difference is one
        // UUID against one email address. The field is populated either way.
        by: 'person',
        who: owner(seed + index),
        reason: prose(160, seed + index),
      });
    }
    built.push({
      id,
      planId,
      controlIds,
      outcome: prose(240, seed),
      definitionOfDone: prose(420, seed + 3),
      owner: owner(seed),
      priority: (['now', 'next', 'later'] as const)[seed % 3] ?? 'next',
      effort: (['small', 'medium', 'large', 'programme'] as const)[seed % 4] ?? 'medium',
      due: new Date(at.getTime() + 60 * DAY_MS),
      steps: Array.from({ length: 4 + (seed % 4) }, (_, step) => prose(110, seed + step)),
      dependsOn: seed % 5 === 0 ? [randomUUID()] : [],
      state,
      raisedFrom: randomUUID(),
      createdBy: owner(seed),
      createdAt: new Date(START.getTime() + seed * 21 * DAY_MS),
      history: [...history],
      revision: index,
    });
  }
  return built;
}

/**
 * The rows one validation attempt leaves behind: revision 0 as requested, and revision 1 once answered.
 *
 * Both, or only the first, and the split is the whole subject. `outstanding` narrows on `answered =
 * false`, which the revision-0 row of an answered attempt carries for ever, so what decides that read's
 * cost is how many attempts an install has ever *requested* rather than how many are open. A fixture
 * where everything is outstanding would measure the one case the read is cheap in.
 */
export function attempts(
  planId: string,
  actionId: string,
  controlIds: readonly string[],
  seed: number,
  answered: boolean
): readonly ValidationAttempt[] {
  const id = randomUUID();
  const claimedAt = new Date(START.getTime() + seed * 21 * DAY_MS);
  const requestedAt = new Date(claimedAt.getTime() + DAY_MS);
  const checks: readonly AttemptCheck[] = controlIds.map((controlId, at) => ({
    controlId,
    method: (['measured', 'attested'] as const)[(seed + at) % 2] ?? 'measured',
  }));
  const requested: ValidationAttempt = {
    id,
    planId,
    actionId,
    checks,
    claimedAt,
    requestedBy: owner(seed),
    requestedAt,
    observeFrom: new Date(requestedAt.getTime() + 7 * DAY_MS),
    observeDays: 7 + (seed % 21),
  };
  if (!answered) return [requested];

  return [
    requested,
    {
      ...requested,
      answer: {
        result: (['passed', 'failed', 'incomplete'] as const)[seed % 3] ?? 'passed',
        scanId: randomUUID(),
        at: new Date(requested.observeFrom.getTime() + DAY_MS),
        // Populated even on a `passed` answer, where all three are empty in practice: the widths here
        // are what a failing or incomplete answer carries, and the body is what the read pays for.
        unmet: controlIds.slice(0, 1 + (seed % 2)),
        unreadable: controlIds.slice(0, seed % 2),
        why: prose(160, seed),
      },
    },
  ];
}

/**
 * One note about a subject, at the width a person writes.
 *
 * Deliberately not threaded into a correction chain past the first: `counts` transfers a row per note
 * whatever the thread, and `for` reads one subject's, so a deeper chain would change the reduction and
 * not the read.
 */
export function note(subjectKind: Note['subject']['kind'], subjectId: string, seed: number): Note {
  const at = new Date(START.getTime() + seed * 11 * DAY_MS);
  return {
    id: randomUUID(),
    subject: { kind: subjectKind, id: subjectId },
    observedIn: randomUUID(),
    corrects: randomUUID(),
    body: prose(300, seed),
    by: owner(seed),
    at,
    definitionId: `assessment-${String(seed % 12)}`,
  };
}
