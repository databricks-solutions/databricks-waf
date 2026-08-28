// What someone said about a practice the platform cannot observe.
//
// 82 of the catalogue's requirements are organisational: whether a governance process
// exists, whether recovery is rehearsed, whether cost is reviewed. No API answers those,
// so without a way to record an answer they are permanently unmeasured — which is most of
// why the assessment reports a quarter of the framework measured. This is the record that
// closes them.
//
// Three properties matter more than the shape.
//
// It names who said it. The tool this app's catalogue was derived from stored qualitative
// answers workspace-globally with no owner, so any user could silently overwrite another's
// answer and nobody could tell whose claim a score rested on. Every record here carries
// the identity that made it and the owner accountable for the practice, and superseding an
// answer records what it replaced rather than erasing it.
//
// It expires. A practice attested once and never revisited is a claim about the past, and
// a score that keeps counting it is a score that improves by ageing. Every attestation
// carries the date it must be renewed by, after which it stops counting and the
// requirement returns to unmeasured.
//
// It cannot overturn a measurement. Where the platform can observe part of a requirement,
// the observation governs and the attestation is recorded alongside it. An assessment
// whose subject can self-certify past a contrary measurement is not an assessment.

import type { Severity } from '../resolve/finding.js';

/**
 * What the attester said, in the four answers a requirement can have.
 *
 * Deliberately the same vocabulary the automated outcomes use, so an attested requirement
 * and a measured one are comparable rather than needing separate handling everywhere
 * downstream. `not-applicable` is included because an organisation genuinely may not be
 * subject to a practice — there is no disaster-recovery rehearsal for an estate with no
 * production workload — and forcing that to be answered `not-met` would report an
 * irrelevant requirement as a failure.
 */
export type AttestedAnswer = 'met' | 'partially-met' | 'not-met' | 'not-applicable';

export const ANSWERS: readonly AttestedAnswer[] = ['met', 'partially-met', 'not-met', 'not-applicable'];

export interface Attestation {
  readonly id: string;
  readonly controlId: string;
  readonly answer: AttestedAnswer;
  /**
   * What the attester is relying on, in their words.
   *
   * Required rather than optional, and this is the field that decides whether the feature
   * is worth having. An answer with no statement behind it is a checkbox, and a wall of
   * ticked checkboxes is what makes maturity self-assessments worthless. A reader reviewing
   * the assessment a year later needs to know what was true, not that somebody clicked yes.
   */
  readonly statement: string;
  /** Where the evidence lives: a runbook, a policy, a ticket. */
  readonly evidenceUrl?: string;
  /**
   * Who is accountable for the practice, which is not always who recorded it.
   *
   * A platform admin can reasonably attest on behalf of the team that owns a process. The
   * distinction is what makes the record useful when it expires: the person to ask is the
   * owner, not whoever happened to be in the app that day.
   */
  readonly owner: string;
  /** The identity that recorded it, from the forwarded user token rather than a form field. */
  readonly attestedBy: string;
  readonly attestedAt: Date;
  /** After this, it stops counting and the requirement returns to unmeasured. */
  readonly reviewBy: Date;
  /** The attestation this replaced, so a history of answers is reconstructable. */
  readonly supersedes?: string;
  /**
   * The assessment this answer was given under.
   *
   * Absent is a fact: the answer named none. It is never guessed into a scope. Two assessments
   * answering the same requirement are two answers, and `current` of either does not return the
   * other's.
   */
  readonly definitionId?: string;
}

/**
 * How long an answer stands before it has to be given again, by how much it matters.
 *
 * A single interval for everything would be wrong in both directions: asking annually
 * whether encryption keys are rotated is too slow for a critical practice, and asking
 * quarterly whether documentation conventions are agreed is how a review process gets
 * abandoned. The catalogue may override per control; these are what it falls back to.
 */
const CADENCE_DAYS: Readonly<Record<Severity, number>> = {
  critical: 90,
  high: 180,
  medium: 365,
  low: 365,
  informational: 365,
};

export function cadenceDaysFor(severity: Severity, catalogueOverride?: number): number {
  return catalogueOverride ?? CADENCE_DAYS[severity];
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where an attestation stands against its own review date.
 *
 * `due` exists so the UI can ask for a renewal before the answer stops counting rather
 * than after. An attestation that lapses silently and drops a requirement out of the score
 * is a score that moves for a reason nobody was told about.
 */
export type AttestationState = 'current' | 'due' | 'expired';

/** The longest due-soon window. A shorter validity period uses its final third instead. */
export const DUE_WINDOW_DAYS = 30;

export function stateOf(attestation: Attestation, now: Date = new Date()): AttestationState {
  const remaining = attestation.reviewBy.getTime() - now.getTime();
  if (remaining <= 0) return 'expired';

  // Assume the final third of a short-lived answer is enough time to renew it. A fixed thirty-day
  // window consumes the whole validity period of a thirty-day catalogue cadence, making a freshly
  // recorded answer due at the instant it is written. Long-lived answers retain the established
  // thirty-day warning rather than growing an ever-larger renewal window.
  const validity = Math.max(0, attestation.reviewBy.getTime() - attestation.attestedAt.getTime());
  const dueWindow = Math.min(DUE_WINDOW_DAYS * DAY_MS, validity / 3);
  return remaining <= dueWindow ? 'due' : 'current';
}

/** Whether it still counts as evidence. Due is still current; expired is not. */
export function counts(attestation: Attestation, now: Date = new Date()): boolean {
  return stateOf(attestation, now) !== 'expired';
}

export function reviewDateFrom(attestedAt: Date, cadenceDays: number): Date {
  return new Date(attestedAt.getTime() + cadenceDays * DAY_MS);
}

/**
 * A submitted attestation, before the parts only the server may decide are attached.
 *
 * The identity, the timestamp and the review date are not in here on purpose. A client that
 * could send `attestedBy` could attribute a claim to a colleague, and one that could send
 * `reviewBy` could attest something as valid for a decade. Both come from the server.
 */
export interface AttestationDraft {
  readonly controlId: string;
  readonly answer: AttestedAnswer;
  readonly statement: string;
  readonly evidenceUrl?: string;
  readonly owner: string;
}

/** The shortest statement worth recording. Below this it is a checkbox with extra steps. */
export const MIN_STATEMENT = 20;

export class InvalidAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAttestationError';
  }
}

/**
 * A draft from an untrusted body, or an error naming the field to fix.
 *
 * Validated here rather than at the route so the same rules apply to any caller, and so
 * the messages can be written once. Every message names what to do, because the person who
 * sees it is filling in a form and "invalid request" tells them nothing about which part.
 */
export function draftFrom(body: unknown, knownControl: (id: string) => boolean): AttestationDraft {
  const raw = (body ?? {}) as Record<string, unknown>;

  const controlId = text(raw.controlId);
  if (controlId == null) throw new InvalidAttestationError('Name the requirement being attested, as controlId.');
  if (!knownControl(controlId)) {
    throw new InvalidAttestationError(`This framework has no requirement with the id ${controlId}.`);
  }

  const answer = text(raw.answer);
  if (answer == null || !ANSWERS.includes(answer as AttestedAnswer)) {
    throw new InvalidAttestationError(`The answer must be one of ${ANSWERS.join(', ')}.`);
  }

  const statement = text(raw.statement);
  if (statement == null || statement.length < MIN_STATEMENT) {
    throw new InvalidAttestationError(
      `Say what the answer rests on, in at least ${String(MIN_STATEMENT)} characters. An answer with no ` +
        'statement behind it cannot be reviewed later.'
    );
  }

  const owner = text(raw.owner);
  if (owner == null) {
    throw new InvalidAttestationError('Name who is accountable for this practice, as owner.');
  }

  const evidenceUrl = text(raw.evidenceUrl);
  if (evidenceUrl != null && !/^https?:\/\//i.test(evidenceUrl)) {
    throw new InvalidAttestationError('The evidence link must be an http or https URL.');
  }

  return {
    controlId,
    answer: answer as AttestedAnswer,
    statement,
    owner,
    ...(evidenceUrl != null ? { evidenceUrl } : {}),
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
