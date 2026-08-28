// What somebody did to this assessment, written down once and never revised.
//
// The app already recorded the *results* of what people did — a scan is a row, an attestation is a
// row, a decision is a row — and every one of those carries who and when. What it had no record of
// was the acts themselves, and the two are not the same set. Three gaps, each of which an auditor
// asks about first:
//
//   The attempts that were refused. `recordRefusal` wrote a line to stdout, which is not a record:
//   it is not queryable, it is gone on the next deploy, and the sentence in `group.ts` said so
//   rather than pretending otherwise. "Who tried to accept a risk they were not allowed to" is the
//   question the gate exists to make answerable, and it was the one thing the gate could not answer.
//
//   The acts that leave no domain row. Cancelling a scan, discarding a draft, archiving an
//   assessment, exporting the register — all of them change what the customer has, and the first
//   three leave nothing behind at all while the fourth leaves the building entirely.
//
//   The acts that failed. A domain row exists only when the write succeeded, so an attempt that got
//   past the gate and then broke is invisible, and "it was tried nine times and never worked" reads
//   identically to "nobody tried".
//
// So an `AuditEvent` records an act rather than its result: what was attempted, by whom, against
// what, and how it ended. It is written whether the act succeeded, failed or was refused, which is
// what makes the absence of an event meaningful — a mutation with no event is a bug in this app
// rather than an act somebody got away with, and `check:audit-coverage` is what holds that true.
//
// # What may not go in one
//
// An audit log is read by more people than any other table here, kept longer than any of them, and
// exported to parties outside the customer. So it holds identifiers and never contents:
//
//   No secrets, obviously, and nothing that could carry one — no request bodies, no headers, no
//   query text, no configuration values.
//
//   No estate data. Not a workspace's settings, not a row a statement returned, not the reason a
//   requirement failed. Those live on the finding, which has its own retention.
//
//   No free text from the caller. `reason` is written by this app from what it knows, not copied
//   from the request, because a field an author controls is a field that carries whatever they
//   paste into it into a document nobody re-reads before handing it to an auditor.
//
// `target` is the exception that proves the rule and it is deliberately narrow: a kind and an id,
// where the id is one this app minted or a control id from the catalogue. Never a name somebody
// typed.

import type { Digest } from '../records/digest.js';

/**
 * What was attempted.
 *
 * A closed set rather than free text, because the point of the log is that somebody can ask it a
 * question — "every risk accepted last quarter", "everything Priya did" — and a set of strings
 * nobody agreed on answers none of them. `check:audit-coverage` refuses a member no route emits, so
 * adding one is a deliberate act rather than a question the trail will always answer with nothing.
 *
 * Named for the act rather than for the route, so the log survives a URL changing and reads as
 * something a person did rather than as traffic.
 *
 * An array rather than a union written out, with the union derived from it. The filter on the trail
 * page offers this vocabulary, which means it is needed at runtime, and a second list beside the
 * type is a list that goes stale — the filter would keep offering an action nobody emits, or stop
 * offering one somebody added, and neither is visible from reading either declaration.
 */
export const AUDIT_ACTIONS = [
  // Runs
  'scan.start',
  'scan.cancel',
  // The advisor's runs, named separately from a scan's rather than folded into `scan.start` with the
  // kind in the target. The trail is read by asking "what has been run against this estate", and the
  // two answers are wanted apart: an advisory run is weekly, cheap to repeat and describes a workload,
  // where a scan is a governance exercise somebody may have to account for. One action for both would
  // make the honest answer to "when was this estate last assessed" a row nobody can tell from advice.
  'advisory.start',
  'advisory.cancel',
  // Starting the scheduled job by hand, which is not `scan.start` and the difference matters to whoever
  // reads this. A scan starts in the app and always works; this starts the job, exercising the compute,
  // the run-as identity and the retry policy that an unattended assessment depends on and that fail
  // where nobody is watching. An auditor asking "was the schedule ever proven to work" is asking for
  // this row, and folding it into `scan.start` would make the answer a scan indistinguishable from any
  // other.
  'schedule.trigger',
  // Statements only a person can make
  'attestation.record',
  'decision.record',
  // Assessments
  'definition.create',
  'definition.revise',
  'definition.archive',
  'definition.unarchive',
  'definition.preflight',
  'draft.read',
  'draft.save',
  'draft.discard',
  'scope.preview',
  // Work somebody took on
  'plan.open',
  'plan.close',
  'action.raise',
  'action.revise',
  'action.move',
  // Asking for a claim to be checked, and taking the question back. There is no `validation.answer`:
  // a run answers one, and no request can cause that — the same reason there is no `action.verify`.
  'validation.request',
  'validation.withdraw',
  // Deciding not to meet a requirement for a while, and ending that early. Two acts rather than one
  // `risk.record` with the outcome in the reason, because they are asked about separately: "what was
  // accepted last quarter" and "what came back on the queue before its date" are different questions.
  'risk.accept',
  'risk.revoke',
  // Taking a requirement out of the customer's own score, and putting it back. Two acts rather than one
  // `applicability.record` with the lever in the reason, and apart from `risk.accept` for the reason
  // ADR 0059 gives: an accepted risk keeps the failure in the score, and an applicability decision
  // removes the requirement from it — "what did we stop scoring ourselves against, and who decided it"
  // is a different question of the trail from "what did we accept while it kept costing us".
  'applicability.record',
  'applicability.revoke',
  // Observations somebody wrote down
  'note.write',
  // Saying which relations this customer serves, and what those must carry. One act rather than a
  // create and a revise pair, because there is only ever one thing to do: a declaration cannot be
  // edited, so every one of these is the next version of the same statement and the trail reads as a
  // history of it. Which version it was is on the target.
  'serving.declare',
  // Opening a review of a completed run, confirming a pillar's answers still stand, skipping one,
  // and answering a requirement from inside the review. Four acts rather than one `review.record`
  // with the kind in the reason, because they are asked about separately: "who opened a review of
  // last night's run", "who said this pillar is still current", and "who skipped a pillar, and
  // when" are different questions of the trail. A skip that shared an act with a confirm would make
  // the trail unable to count skips without reading every reason.
  //
  // `review.answer` is its own act rather than `attestation.record` for the narrower reason that it
  // is a different question: the trail is asked who answered a requirement, and separately whether
  // the reviewer of this run answered anything while reviewing it. Both acts name the requirement
  // as their target, so the first question is still answered by either.
  'review.open',
  'review.confirm',
  'review.skip',
  'review.answer',
  // Evidence that came from outside
  'evidence.import',
  // Artefacts that leave the building. Two, because they answer different questions of the trail: "who
  // was told what the estate looks like" and "who was told what we said we would do about it". A single
  // `export` with the subject in the target would make the second answerable only by reading ids.
  'export.scan',
  'export.plan',
  // How long records are kept, and what is removed
  'retention.configure',
  'retention.hold',
  'retention.release',
  'retention.sweep',
  // Emptying the install. Filed with retention because it is the same surface and the same gate, and
  // deliberately not called `retention.reset`-something-softer: the word for it is the word for it.
  'retention.reset',
  // Publishing a month, and correcting one. Two acts rather than one `month.write` with the kind in the
  // reason, because the trail is asked them apart: "which months were published, and when" is the
  // cadence's own record, and "which published month was later corrected, and why" is the question a
  // reader asks when two copies of a month disagree. A supersession names the publication it replaces
  // and carries a reason; a first publication does neither, and one action for both would make the
  // reason read as absent on the ones that never had one.
  'month.publish',
  'month.supersede',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Each act in the words a person would use for it.
 *
 * Here rather than beside the route that refuses, and rather than in the client, because three
 * places need the same sentence about the same act: the refusal log line ("refused to start a
 * scan"), the trail page's filter, and each row of the trail itself. `scan.start` is what the app
 * calls it and is not what an auditor should have to read.
 *
 * Served to the client on the trail payload rather than compiled into it. A client-side copy is a
 * second statement of the vocabulary, and the failure mode is silent in both directions: a phrase
 * the app no longer emits keeps being offered as a filter, and an act somebody added shows up in the
 * list as its identifier while the filter has never heard of it.
 *
 * Written as a verb phrase that completes "refused to …" and "Priya asked to …", which is what makes
 * one string do for a refusal line and a table row. A noun phrase would need two.
 */
export const AUDIT_PHRASES: Readonly<Record<AuditAction, string>> = {
  'scan.start': 'start a scan',
  'scan.cancel': 'cancel the running scan',
  'advisory.start': 'ask the advisor to look at the workload',
  'advisory.cancel': 'cancel the running advisory run',
  'schedule.trigger': 'start the scheduled assessment by hand',
  'attestation.record': 'answer a requirement',
  'decision.record': 'decide a finding',
  'definition.create': 'create an assessment',
  'definition.revise': 'revise an assessment',
  'definition.archive': 'archive an assessment',
  'definition.unarchive': 'put an archived assessment back',
  'definition.preflight': 'check what an assessment would read',
  'draft.read': 'read an unfinished assessment',
  'draft.save': 'save an unfinished assessment',
  'draft.discard': 'discard an unfinished assessment',
  'scope.preview': 'preview an assessment scope',
  'plan.open': 'open an improvement plan',
  'plan.close': 'close an improvement plan',
  'action.raise': 'raise an action',
  'action.revise': 'revise an action',
  // Deliberately not "verify": no request can reach the verified state, and a phrase that implied one
  // could would be the trail describing an act the app refuses.
  'action.move': 'move an action to another state',
  'validation.request': 'ask for claimed work to be validated by a run',
  'validation.withdraw': 'withdraw a claim waiting to be validated',
  'risk.accept': 'accept a requirement being unmet for a while',
  'risk.revoke': 'end an accepted risk early',
  'applicability.record': 'take a requirement out of the score as not applicable or disabled',
  'applicability.revoke': 'put a requirement excluded from the score back into it',
  // One phrase for a note and for a correction of one, because a correction is a note: it is written,
  // it is attributed, and it names the note it corrects. A second act would be the trail claiming the
  // earlier note had been changed, which is the one thing a note cannot be.
  'note.write': 'write a note',
  'serving.declare': 'declare which data this organisation serves',
  'review.open': 'open a review of a run',
  'review.confirm': 'confirm a pillar is still current',
  'review.skip': 'skip a pillar',
  'review.answer': 'answer a requirement while reviewing its pillar',
  'evidence.import': 'import collected evidence',
  'export.scan': 'export a run',
  'export.plan': 'export an improvement plan',
  'retention.configure': 'set how long records are kept',
  'retention.hold': 'place a legal hold',
  'retention.release': 'lift a legal hold',
  'retention.sweep': 'remove records that are past their retention period',
  'retention.reset': "delete this install's assessment data",
  'month.publish': 'publish a month',
  'month.supersede': 'publish a correction to a month',
};

/** How the act ended. Three, because the difference between them is what an auditor is reading for. */
export type AuditOutcome =
  /** It happened. */
  | 'performed'
  /** The gate turned the caller away. */
  | 'refused'
  /** The caller was permitted and the act did not complete. */
  | 'failed';

/**
 * What was acted on.
 *
 * Optional, because some acts have no object until they succeed — creating an assessment mints the
 * id it is about — and recording the event only after the id exists would mean a failed create
 * leaves nothing, which is one of the three gaps this table was written for.
 */
export interface AuditTarget {
  readonly kind:
    | 'scan'
    /**
     * A run, which is what somebody asks for and is not the same thing as the scan it produces.
     *
     * Both, rather than one standing in for the other, because a run has an id from the moment it is
     * asked for and a scan only has one once there is a result. An addressed cancellation and a retry
     * that was refused are both acts on a run that produced no scan, and a trail that could only name
     * scans would record them against nothing.
     */
    | 'run'
    | 'control'
    | 'definition'
    | 'draft'
    | 'evidence'
    | 'legal-hold'
    | 'artefact'
    | 'plan'
    | 'action'
    /**
     * The scheduled job, named rather than numbered.
     *
     * The one target whose id is not something this app minted, and the exception is forced: the app
     * finds the job by name so that deleting `resources/scheduled-scan.yml` opts out cleanly, so at the
     * moment a refusal has to be recorded there may be no id to record. A name that is a constant in
     * this codebase rather than something somebody typed is the nearest thing to an id available, and
     * `null` would leave the refusal attached to nothing.
     */
    | 'job'
    /**
     * A pillar, which is a target only because a note can be written about one.
     *
     * A note's target is what the note is about rather than the note itself, so the question an
     * auditor asks — everything anybody recorded about this requirement — is answered by one search
     * whether the record was an attestation, a decision or somebody's paragraph. A note id as the
     * target would answer a question nobody has: they do not know the id, and if they did they would
     * be looking at the note.
     */
    | 'pillar'
    /**
     * A serving declaration, by its version.
     *
     * The version rather than the population it selects, because the population is a consequence of
     * the declaration and the catalogue on the day it was read, and neither is a thing the trail can
     * name. "Who changed what we call our serving data, and to what" is answered by the version and
     * the declaration it addresses.
     */
    | 'serving'
    /**
     * A published month, named by its `YYYY-MM` rather than by a publication id.
     *
     * The act an auditor asks about is "who published August", and a month has one answer to that
     * whether it was published once or corrected three times — so the target is the month, and the
     * particular publication is found by reading the month's publications in order. A publication id
     * as the target would split "who published August" across as many rows as there were corrections,
     * which is the opposite of what the log is asked. The `YYYY-MM` is minted by no one and typed by
     * no one: it is the calendar's, validated by `parseMonth` before it reaches here.
     */
    | 'month';
  /** An id this app minted, or a control id from the catalogue. Never a name somebody typed. */
  readonly id: string;
  /**
   * The digest of the target's content, for the one kind of target that has content of its own.
   *
   * An `artefact` — a file this app produced and handed over — is the only object in the log that
   * leaves. Every other target can be looked up here, so its row needs no more than an id; a file
   * cannot, so the row is the only place the two claims "this file came from here" and "this file
   * has not changed since" can both be recorded. The digest is over the bytes as sent, so a
   * recipient checks it with `shasum -a 256` and no access to this app. ADR 0050.
   *
   * Optional, and absent for every other kind. A digest of a record would be a copy of something
   * already stored beside that record, and two copies of a digest is a way for them to disagree.
   */
  readonly digest?: Digest;
}

/**
 * One act, as it is written down.
 *
 * `at` is when the app decided the outcome rather than when the request arrived, so an act and its
 * effect carry the same instant and a reader joining the two does not find them a second apart.
 */
export interface AuditEvent {
  readonly id: string;
  readonly at: Date;
  /** Who, from the forwarded identity. Never from the request body — see `permitted` in routes. */
  readonly actor: string;
  /**
   * How the caller was authorised, so a scheduled run and a person are told apart in the log.
   *
   * The same vocabulary as `ScanStamp.executionMode`, and deliberately not imported from it: the
   * scan module owning the word every audit row is stamped with would make an audit row a thing
   * that cannot be written without the scanner, and the log covers acts that have nothing to do
   * with a scan.
   */
  readonly executionMode: 'on-behalf-of-user' | 'service-principal';
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly target?: AuditTarget;
  /**
   * Why it ended that way, in this app's words. Present on `refused` and `failed`, absent on
   * `performed` — "it worked" needs no explanation and a column of them would be noise to scroll.
   *
   * Written from what this app knows: the refusal kind, the error class. Never the caller's text,
   * and never an exception message, which can carry a connection string.
   */
  readonly reason?: string;
  /**
   * The run, upload or request this act belongs to, when it belongs to something larger.
   *
   * What it buys is the question "what happened around this" without a timestamp range: eleven
   * events sharing a correlation are one scan's story, and the same eleven found by time are those
   * plus whatever else the estate was doing.
   */
  readonly correlation?: string;
  /**
   * How much a reset destroyed. Present on `retention.reset` and on nothing else.
   *
   * This is the one exception to "no counts in the log", and the reason it is an exception is the
   * reason it exists at all. Every other act leaves its scale readable elsewhere: a sweep removed
   * four scans and the next read of the plan shows the four that are left, so putting the number in
   * the event as well would be a second copy that can disagree — the sweep route says so where it
   * declines to. A reset removes the records the count could be recomputed from, and its own event is
   * the chain's new root. There is nowhere else for the number to be. Left out, the trail would say
   * an install was emptied and would not be able to say of what, which is the difference ADR 0048's
   * amendment names between a record of an act and a record that an act happened.
   *
   * Two integers this app counted, so it carries nothing `event.ts` forbids: no estate data, no
   * caller text, nothing that could hold a secret. Named for the act rather than as `counts` or
   * `detail`, because a general-purpose bag on this type is how the next author puts a table name, a
   * workspace or a query into an audit row that outlives the incident and leaves the building.
   */
  readonly emptied?: {
    readonly rows: number;
    readonly tables: number;
  };
}

/** An event as it is stored, with its place in the chain. */
export interface ChainedAuditEvent extends AuditEvent {
  /** 1 for the first event ever written. Contiguous, which is what makes a deletion visible. */
  readonly sequence: number;
  /**
   * The digest of the event before this one, or the genesis constant for the first.
   *
   * This is the whole of the tamper evidence. A digest alone catches an edited body, and is
   * defeated by an editor who recomputes it (ADR 0032 says so in those words). Chaining means
   * recomputing one event's digest makes the next event's `previous` wrong, so hiding an edit
   * means rewriting every event after it — and the head digest, which the app publishes and an
   * export carries, will still not match the one recorded before the edit.
   */
  readonly previous: Digest;
  /** Over the canonical bytes of this event *including* `sequence` and `previous`. */
  readonly digest: Digest;
}

/**
 * What the first event's `previous` points at.
 *
 * A constant rather than an empty string, so an empty `previous` reads as a missing value and never
 * as a legitimate start of chain. The bytes are the algorithm's zero digest, which is a value no
 * event can have.
 */
export const GENESIS: Digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
