// A run described in words, kept out of the table so it can be tested.
//
// Every function here answers a question a history row raises and a bare number cannot: how
// long it took, what it found, how much of the estate it actually measured itself, and who it
// ran as. They are pure and exported so the phrasing is asserted rather than eyeballed — these
// sentences are the difference between a legible record and a column of timestamps.

import type { Finding, OutcomeCounts, ScanSummary } from '../api/types';

/**
 * The outcome counts of a set of findings.
 *
 * Needed on the client as well as the server because the history index carries counts while a
 * full scan payload carries findings, and the run page shows both. Kept here so the two agree —
 * in particular on architecture-satisfied counting as met, which is the one judgement in it.
 */
export function countOutcomes(findings: readonly Finding[]): OutcomeCounts {
  const of = (...outcomes: readonly Finding['outcome'][]) =>
    findings.filter((finding) => outcomes.includes(finding.outcome)).length;

  return {
    pass: of('pass', 'satisfied-by-architecture'),
    fail: of('fail'),
    partial: of('partial'),
    unmeasurable: of('unmeasurable'),
    notApplicable: of('not-applicable'),
  };
}

/** How long the run took, at a precision a reader can act on. */
export function duration(scan: Pick<ScanSummary, 'startedAt' | 'finishedAt'>): string {
  return spell(new Date(scan.finishedAt).getTime() - new Date(scan.startedAt).getTime());
}

/**
 * How long a run has been going, for a reader watching one happen.
 *
 * `now` is a parameter rather than read here so the caller owns the clock — the component that
 * shows this re-renders on a timer, and a function that read the time itself could not be tested
 * for the shape of a two-minute wait without waiting two minutes.
 *
 * A clock that has gone backwards reads as just started rather than as a negative wait: the server
 * stamps the start and the browser reads the elapsed, and the two are not the same clock.
 */
export function elapsed(startedAt: string, now: number): string {
  return spell(Math.max(0, now - new Date(startedAt).getTime()));
}

function spell(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${String(ms)}ms`;

  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${String(seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(seconds % 60)}s`;
}

/**
 * What the run found.
 *
 * Not met leads, because it is the only count anyone acts on. Unmeasured is named rather than
 * folded into a total, since a run of 40 requirements where 30 were unreadable is a different
 * fact from one where 30 passed and must not add up to the same-looking row.
 */
export function results(counts: OutcomeCounts): string {
  const parts = [
    `${String(counts.fail)} not met`,
    counts.partial > 0 ? `${String(counts.partial)} partly` : undefined,
    `${String(counts.pass)} met`,
    counts.unmeasurable > 0 ? `${String(counts.unmeasurable)} unmeasured` : undefined,
  ].filter((part): part is string => part != null);

  return parts.join(', ');
}

/**
 * How much of the result this run measured itself.
 *
 * A targeted rerun produces a full set of pillars of which it measured one, and the whole point
 * of recording the request is that the row cannot then read as a full scan. Where nothing was
 * carried forward the phrasing stays short, because most runs are full ones and a hedge on
 * every row teaches people to skip it.
 */
export function measured(scan: Pick<ScanSummary, 'measuredPillars' | 'freshPillars'>): string {
  const total = scan.measuredPillars.length;
  const fresh = scan.freshPillars.length;

  if (total === 0) return 'none';
  if (fresh === total) return `${String(total)} measured`;
  if (fresh === 0) return `${String(total)} all carried forward`;
  return `${String(fresh)} of ${String(total)} measured, ${String(total - fresh)} carried forward`;
}

/** Which pillars a targeted rerun was asked for, for the row's own detail line. */
export function requestSentence(
  scan: Pick<ScanSummary, 'requestedPillars' | 'freshPillars'>,
  title: (pillarId: string) => string
): string | undefined {
  const requested = scan.requestedPillars;
  if (requested == null) return undefined;

  const names = requested.map(title).join(', ');
  const missed = requested.filter((pillarId) => !scan.freshPillars.includes(pillarId));

  // A pillar asked for and not delivered is the one case worth a sentence of its own: the
  // reader would otherwise take the request as the record of what happened.
  return missed.length === 0
    ? `Rerun of ${names}`
    : `Rerun of ${names}, of which ${missed.map(title).join(', ')} produced no result`;
}

/**
 * An application id, which is the only form a service principal's name arrives in.
 *
 * Shape rather than a flag, because the mode could not answer this for the runs already stored.
 * A scheduled run reaches the app through the same on-behalf-of door as a browser — measured, ADR
 * 0021 — and until row 40f the server wrote the mode as a literal, so every stored run says
 * `on-behalf-of-user` while some of them were a service principal's. Three places in the interface
 * inferred "a person" from that mode, and all three named a nightly service principal the signed-in
 * user. Runs written since carry the derived mode, which is why the test below holds this rule and
 * the server's `modeFor` to the same answers: they are one rule in two build trees.
 *
 * A person's actor is the email or username the proxy forwards, and a service principal's is its
 * application id. Those are not confusable in either direction.
 */
const APPLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What is enough to name whoever ran something.
 *
 * The mode is optional because an advisory record does not carry one, and the shape test above is
 * what actually answers the question for both — so an advisory's actor is named by the same rule the
 * scans are named by rather than by a second one that would drift from it.
 */
export type Ran = Pick<ScanSummary, 'actor'> & Partial<Pick<ScanSummary, 'executionMode' | 'actorName'>>;

export function ranAsServicePrincipal(scan: Ran): boolean {
  // Trimmed, because the server's copy of this rule trims before it stamps: an actor arriving with
  // whitespace would otherwise be a principal there and a person here, which is the one way these
  // two are allowed to disagree and the reason the cross-check test exists.
  return scan.executionMode === 'service-principal' || APPLICATION_ID.test(scan.actor.trim());
}

/** Who ran it, and which kind of identity that is. The two see different estates. */
export function identity(scan: Pick<ScanSummary, 'actor' | 'executionMode'>): string {
  return ranAsServicePrincipal(scan) ? 'service principal' : 'signed-in user';
}

/**
 * Who ran it, named so a reader can recognise them.
 *
 * A service principal's application id is a UUID, which reads as noise unless it is labelled as
 * an identity — so it is labelled, rather than printed bare next to a column of email addresses.
 *
 * Where the run recorded what that principal calls itself, the name is used instead of the id and the
 * label is kept: `service principal waf-schedule-probe` is recognisable to the person who granted it
 * in a way that thirty-six hex characters never were. The label stays because the name alone would
 * sit in a column of email addresses looking like a username, and the two are not interchangeable —
 * one can be added to a group, the other cannot.
 *
 * The substitution is only for service principals, which is why it is decided here rather than by the
 * server that records the name. A person's actor is already the email an admin recognises, and
 * replacing it with a display name would lose the thing that identifies them to look up.
 */
export function actorName(scan: Ran): string {
  return ranAsServicePrincipal(scan) ? `service principal ${whoRan(scan)}` : scan.actor;
}

/**
 * Whoever ran it, unlabelled: the recorded name where there is one, the actor otherwise.
 *
 * For the places that state the kind of identity separately and would otherwise say it twice — the
 * history table names the identity on one line and captions it "service principal" on the next, so
 * `actorName`'s label would read as "service principal waf-schedule-probe / service principal" there.
 */
export function whoRan(scan: Ran): string {
  const named = scan.actorName?.trim();
  return named != null && named !== '' ? named : scan.actor;
}

/**
 * Whoever ran it with the identifier as well, for the one panel that has to be enough to repeat the run.
 *
 * The name is what a reader recognises and the application id is what they would type, and this is the
 * single place both are worth the room: "what this result covers" exists so somebody who disputes a
 * number can make the same reading themselves, and a name they cannot look up would not let them.
 * Everywhere else picks one.
 */
export function whoRanInFull(scan: Ran): string {
  const named = scan.actorName?.trim();
  return named != null && named !== '' && named !== scan.actor ? `${named} (${scan.actor})` : scan.actor;
}

/**
 * Whether anybody was watching, for runs that recorded it.
 *
 * Undefined for a run from before the trigger was kept. That is deliberately not rendered as
 * "by hand": the record does not say, and filling the gap with the commoner case would put a
 * fact in the history that was never measured.
 */
export function startedBy(scan: Pick<ScanSummary, 'trigger'>): string | undefined {
  if (scan.trigger == null) return undefined;
  return scan.trigger === 'scheduled' ? 'on a schedule' : 'by hand';
}
