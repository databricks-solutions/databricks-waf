// Which store this install gets, and why.
//
// Lakebase, or the app does not start. That is a change of posture: a Unity Catalog volume was
// optional and its absence downgraded the app to in-memory history, on the grounds that somebody
// evaluating it should not have to provision storage first. Two things retire that argument. The
// app no longer arrives as a listing somebody clicks to try, so there is no evaluator whose first
// five minutes are being protected; and a database is bound by the same bundle that deploys the
// app, so binding it is not a separate errand. ADR 0031.
//
// Memory remains reachable, behind a flag that says out loud what it is for. A demo that keeps
// nothing is a legitimate thing to want; a production install that quietly keeps nothing is not,
// and the old default made those two indistinguishable from the outside.

import { InMemoryScanStore, type ScanStore } from './store.js';
import { PostgresScanStore } from './postgres-store.js';
import { InMemoryAttestationStore, type AttestationStore } from '../attest/store.js';
import { PostgresAttestationStore } from '../attest/postgres-store.js';
import { InMemoryDecisionStore, PostgresDecisionStore, type DecisionStore } from '../decide/store.js';
import { InMemoryDefinitionStore, type DefinitionStore } from '../define/store.js';
import { PostgresDefinitionStore } from '../define/postgres-store.js';
import { InMemorySetupDraftStore, type SetupDraftStore } from '../define/setup-store.js';
import { InMemoryEvidenceImportStore, PostgresEvidenceImportStore, type EvidenceImportStore } from '../import/store.js';
import { PostgresSetupDraftStore } from '../define/setup-postgres-store.js';
import { InMemoryAuditLog, PostgresAuditLog, type AuditLog } from '../store/audit-log.js';
import { InMemoryImprovementStore, type ImprovementStore } from '../improve/store.js';
import { PostgresImprovementStore } from '../improve/postgres-store.js';
import { InMemoryNoteStore, type NoteStore } from '../note/store.js';
import { PostgresNoteStore } from '../note/postgres-store.js';
import { InMemoryServingStore, type ServingStore } from '../foundation/serving-store.js';
import { PostgresServingStore } from '../foundation/serving-postgres-store.js';
import { InMemoryReviewStore, type ReviewStore } from '../review/store.js';
import { PostgresReviewStore } from '../review/postgres-store.js';
import type { FinalAssessmentProjector } from '../review/projection.js';
import { InMemoryValidationStore, type ValidationStore } from '../validate/store.js';
import { PostgresValidationStore } from '../validate/postgres-store.js';
import { InMemoryRiskStore, type RiskStore } from '../accept/store.js';
import { PostgresRiskStore } from '../accept/postgres-store.js';
import type { ApplicabilityStore } from '../apply/store.js';
import { PostgresApplicabilityStore } from '../apply/postgres-store.js';
import { PostgresRetentionGateway, PostgresRetentionStore, type RetentionStore } from '../admin/retention-store.js';
import { PostgresRunStore, type RunStore } from '../run/run-store.js';
import { PostgresAdvisoryStore, type AdvisoryStore } from '../advise/store.js';
import { PostgresPlanExtractStore, type PlanExtractStore } from '../advise/plan-store.js';
import { PostgresPublicationStore, type PublicationStore } from '../monthly/store.js';
import type { RetentionGateway } from '../admin/retention.js';
import type { ResetGateway } from '../admin/reset.js';
import { openPostgres, type OpenOptions, type Postgres } from '../store/postgres.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { verifyRecords, type VerificationReport } from '../records/verify.js';

/**
 * Set to `1` to run with no durable store at all.
 *
 * Named for what it is rather than what it does. `WAF_EPHEMERAL_STORE=1` would read as a tuning
 * knob; this cannot be set by somebody who thinks they are configuring a cache.
 */
export const DEMO_ENV = 'WAF_DEMO_NO_PERSISTENCE';

export interface StoreChoice {
  readonly store: ScanStore;
  /**
   * Where attested answers are kept: the same database, in the same schema, on the same terms.
   *
   * One binding rather than three. A consumer prompted for three databases at deploy time would
   * reasonably wonder what the difference was, and there isn't one worth explaining.
   */
  readonly attestations: AttestationStore;
  /** Where decisions about findings are kept. The same database again, for the same reason. */
  readonly decisions: DecisionStore;
  /** Where assessment definitions are kept. The same database again. */
  readonly definitions: DefinitionStore;
  /**
   * Where an assessment part-written is kept, so leaving the page does not lose it.
   *
   * The same database again, and the same binding, but the lowest stakes of the five: a lost draft
   * costs somebody the typing they had not finished, where a lost definition costs a finished run its
   * meaning. That is why it is the only one of these that is deleted rather than kept forever.
   */
  readonly drafts: SetupDraftStore;
  /**
   * Where admin-collected evidence is kept once an upload has been believed.
   *
   * The same database again, and the only one of the six that carries no explanation string beside
   * it. It does not need one: the import endpoint reports the store's own `durable` flag, and the page
   * that offers the upload is the only place the answer is wanted — where it has to be phrased about
   * evidence rather than about history.
   */
  readonly imports: EvidenceImportStore;
  /**
   * Where acts are written down.
   *
   * Carries no explanation string either, for the same reason as `imports` and one more: the trail
   * reports its own `durable` flag, and the sentence a reader needs about a trail that forgets is not
   * about restarts — it is that the absence of an event stops meaning anything, which is a paragraph
   * belonging on the page that shows the trail.
   */
  readonly audit: AuditLog;
  /**
   * Where improvement plans and the actions in them are kept.
   *
   * The same database again, and the one whose loss is least recoverable of all of them. A scan can be
   * re-run and an answer retyped from the same knowledge; a plan is a fortnight of agreements between
   * people about who is doing what by when, and nothing in the estate holds a copy — the estate knows
   * what is wrong, not what anybody decided to do about it.
   */
  readonly improvements: ImprovementStore;
  /**
   * Where notes are kept.
   *
   * The same database, and the cheapest record here to lose by accident: a note is one paragraph
   * somebody wrote while reading a run they will not open again, so nothing else in the app hints that
   * it was ever there. A missing scan is conspicuous and a missing note is not.
   */
  readonly notes: NoteStore;
  /**
   * Where reviews of completed runs, pillar records, and finalised results are kept.
   *
   * The same database. Its loss is a judgement somebody made while reading a run they will not
   * open again, and the result publication will later read — gone on the next deploy, with the
   * scan still showing a score nobody finalised.
   */
  readonly reviews: ReviewStore;
  /**
   * Where the attempts to validate claimed work are kept.
   *
   * The same database again. Its loss is peculiar among these: an attempt lost takes with it the only
   * evidence behind a `verified`, so what survives is an action the app says a run agreed with and no
   * record of which run, what it read, or how many attempts it took to get there.
   */
  readonly validations: ValidationStore;
  /**
   * Where the requirements somebody accepted rather than met are kept.
   *
   * The same database again, and the one whose loss changes what the app says about the estate rather
   * than only what it remembers: an acceptance lost is a finding back on the queue with no record that
   * anybody looked at it, no compensating control, and no owner — which reads as an assessment nobody
   * has read rather than as one whose exposures were considered.
   */
  readonly risks: RiskStore;
  /**
   * Where the requirements a customer took out of their own score are kept.
   *
   * The same database again, and its loss lands the opposite way from most here: an accepted risk lost
   * puts a failure back on the queue, but an applicability decision lost puts a requirement a customer
   * deliberately excluded back *into* their score — a number that moves against them, for a reason
   * nobody recorded. So it is durable or it is not offered: an in-memory install has no exclusion path
   * rather than one that forgets, the way the publications do.
   */
  readonly applicability?: ApplicabilityStore;
  /**
   * Where the retention position is kept: the periods, and the holds.
   *
   * Absent in the memory case, with the gateway below, and the two travel together deliberately. An
   * earlier version had the store on every install, on the reasoning that a period is a statement
   * rather than a record and an administrator should be able to read this app's position either way.
   * The trouble is what that renders: three configurable periods, an empty eligibility count under
   * each, and a sweep button that removes nothing — a policy somebody can set, and which governs
   * nothing at all. The route says so in a sentence instead, which is the whole of the true answer.
   */
  readonly retention?: RetentionStore;
  /**
   * Counts and removes rows: past their period for a sweep, and all of them for a reset.
   *
   * Separate from the store only because they are different things, not because either is available
   * without the other. An in-memory gateway deleting from arrays would be a sweep reporting removals
   * nobody needed, over records that were about to be lost on the next restart anyway.
   */
  readonly retentionGateway?: RetentionGateway & ResetGateway;
  /**
   * Where a run of the assessment is recorded, so it outlives the process that started it.
   *
   * Absent in the memory case, and its absence is what makes an in-memory install honest rather than
   * degraded: with nothing durable behind it, a run interrupted has nothing to be resumed *from* — the
   * checkpoints would be in the same memory the scan was. An install that recorded runs in an array
   * would answer "what became of last night's run" with silence after every restart, which is the
   * failure mode runs exist to remove and would be worse for looking like it had been fixed.
   */
  readonly runs?: RunStore;
  /**
   * Where the workload advisor's conclusions are kept.
   *
   * Absent in the memory case for the reason the runs are, and with a sharper consequence: advice is
   * the one thing here whose value is entirely in being returned to. A recommendation nobody can find
   * next week is a recommendation nobody acted on, so an install with nothing durable has no advisor
   * rather than an advisor that forgets.
   */
  readonly advisories?: AdvisoryStore;
  /**
   * Where the query plans an advisory run read are kept.
   *
   * Absent whenever `advisories` is, and it has to be the pair rather than either alone: a plan is kept
   * to be compared against the next one, so a run that could store plans and not its own summary would
   * be keeping the comparison and losing what it concluded from it. A3b's rule is the same point put the
   * other way — a new record type may not inherit a store that forgets — and the advisor's answer to it
   * is that an install with nothing durable has no advisor.
   */
  readonly planExtracts?: PlanExtractStore;
  /**
   * Where published months are kept.
   *
   * Absent in the memory case, and its absence is what keeps a demo honest: a published month is a
   * permanent, digest-bearing record, and one held in an array is gone on the next deploy — which is
   * worse than not offering to publish, because a recipient would be handed a digest for bytes the app
   * can no longer produce. So an in-memory install has no publish path rather than one that forgets,
   * and 28b's endpoint says so in a sentence.
   */
  readonly publications?: PublicationStore;
  /**
   * Where a customer's statement of what they serve is kept.
   *
   * Present in both cases, and the memory one warns rather than refusing. A readiness reading is a
   * reading *of* a declaration — the fingerprint travels on the outcome for that reason — so a lost
   * declaration does not lose a reading so much as strand every one ever taken: they name a version
   * that no longer exists. That is a sentence rather than an absent capability because the
   * declaration itself is cheap to retype, which is the test A3b's rule actually applies.
   */
  readonly serving: ServingStore;
  /** Shown in the UI. Says what the install can and cannot do, in the user's terms. */
  readonly explanation: string;
  /**
   * The same for answers, phrased for the higher stakes.
   *
   * A lost scan is a button press away from being recovered. A lost attestation is somebody's
   * written statement about how their organisation works, so the non-durable case has to read as a
   * warning rather than as a note.
   */
  readonly attestationExplanation: string;
  /** The same for decisions, whose loss is a record of who accepted what rather than a score. */
  readonly decisionExplanation: string;
  /**
   * The same for definitions, whose loss takes the meaning of every run with it.
   *
   * Phrased for the highest stakes of the four. A lost scan can be re-run and a lost answer retyped,
   * but a run stamped with a definition version that is no longer stored is a finished assessment
   * that cannot say what it was of — which is the thing definitions exist to make answerable.
   */
  readonly definitionExplanation: string;
  /** The same for plans, phrased for work that only exists here. */
  readonly improvementExplanation: string;
  /** The same for notes, whose loss is silent — see `notes` above. */
  readonly noteExplanation: string;
  /**
   * The same for serving declarations, phrased for what a lost one takes with it.
   *
   * Present in both cases rather than absent in the memory one, unlike the advisor. A declaration is
   * something somebody types in one sitting and a demo needs to be able to show what a readiness
   * reading looks like — and unlike an advisory run, losing it costs nothing that was expensive to
   * produce. What it does cost is the meaning of every reading taken against it, which is what this
   * sentence has to say.
   */
  readonly servingExplanation: string;
  /** The same for reviews, whose loss is a finalisation nobody can find. */
  readonly reviewExplanation: string;
  /** The same for validations, phrased for evidence a `verified` depends on. */
  readonly validationExplanation: string;
  /** The same for accepted risks, phrased for an exposure whose record is the only thing watching it. */
  readonly riskExplanation: string;
  /**
   * Reads every stored record back and checks it against its digest. Absent when nothing is stored.
   *
   * A function on the choice rather than a method on the three stores, because the question spans
   * them: "are the records this app wrote still what it wrote" is one answer about one database, and
   * three separate answers would leave whoever asked to decide what to make of two passes and a
   * failure. It is absent in the memory case because there is nothing there to have been edited —
   * see the endpoint, which says that rather than reporting a vacuous pass.
   */
  readonly verify?: () => Promise<VerificationReport>;
  /**
   * Answers if the database is reachable, and throws with why if it is not. Absent when there is none.
   *
   * Its own capability rather than reusing `verify`, which reads every stored record back: the
   * diagnostics page asks whether the database answers, and answering that by checksumming the whole
   * history would make opening a status page the most expensive read in the app.
   */
  readonly ping?: () => Promise<void>;
  /** Closes the pool on shutdown. Absent when there is no pool to close. */
  readonly close?: () => Promise<void>;
}

export interface StoreChoiceOptions extends OpenOptions {
  readonly onError?: (operation: string, error: unknown) => void;
  /**
   * Catalogue pillar ids, so a result is written when each has a confirm or a skip.
   *
   * Passed in rather than read from the catalogue here, because this module chooses stores and
   * has no business loading the framework. Empty means nothing ever finalises, which is what a
   * test that only asks whether the store is durable wants.
   */
  readonly pillars?: readonly string[];
  /** Pure Version 2 final-assessment projection, constructed from the loaded catalogue and registry. */
  readonly projector?: FinalAssessmentProjector;
}

/**
 * The stores, or a thrown error naming what is unbound.
 *
 * Throwing rather than degrading is the whole point of this change, and the caller is expected to
 * catch it and serve the explanation rather than exit — an app that dies leaves a stack trace in a
 * log the person who deployed it may not be able to read. See ADR 0011 and `server.ts`.
 */
export async function chooseStore(options: StoreChoiceOptions = {}): Promise<StoreChoice> {
  const env = options.env ?? process.env;

  if ((env[DEMO_ENV] ?? '').trim() === '1') {
    const store = new InMemoryScanStore();
    const attestations = new InMemoryAttestationStore();
    return {
      store,
      attestations,
      decisions: new InMemoryDecisionStore(),
      definitions: new InMemoryDefinitionStore(),
      drafts: new InMemorySetupDraftStore(),
      imports: new InMemoryEvidenceImportStore(),
      audit: new InMemoryAuditLog(),
      improvements: new InMemoryImprovementStore(),
      notes: new InMemoryNoteStore(),
      serving: new InMemoryServingStore(),
      reviews: new InMemoryReviewStore({
        pillars: options.pillars ?? [],
        ...(options.projector != null
          ? {
              projection: {
                project: options.projector,
                scan: (id: string) => store.get(id),
                attestation: (id: string, scope?: AssessmentScope) => attestations.get(id, scope),
              },
            }
          : {}),
      }),
      validations: new InMemoryValidationStore(),
      risks: new InMemoryRiskStore(),
      explanation:
        `This app is running with ${DEMO_ENV} set, so nothing is kept. Scan history, attested answers and ` +
        'decisions are held in memory and lost when the app restarts, which happens on every deploy and ' +
        'whenever the platform scales it. Unset it and bind a Lakebase database to keep them.',
      attestationExplanation: NOT_KEPT,
      decisionExplanation: DECISIONS_NOT_KEPT,
      definitionExplanation: DEFINITIONS_NOT_KEPT,
      improvementExplanation: PLANS_NOT_KEPT,
      noteExplanation: NOTES_NOT_KEPT,
      servingExplanation: SERVING_NOT_KEPT,
      reviewExplanation: REVIEWS_NOT_KEPT,
      validationExplanation: VALIDATIONS_NOT_KEPT,
      riskExplanation: RISKS_NOT_KEPT,
    };
  }

  const db = await openPostgres(options);
  const durable = { db, ...(options.onError ? { onError: options.onError } : {}) };
  const where = `the ${db.schema} schema of the bound Lakebase database`;
  // Named rather than constructed inline, because the validation store reads plans through it. One
  // instance for both, so a plan read on the way to ageing an attempt is the same store the routes use.
  const improvements = new PostgresImprovementStore(durable);
  const store = new PostgresScanStore(durable);
  const attestations = new PostgresAttestationStore(durable);

  return {
    store,
    attestations,
    decisions: new PostgresDecisionStore(durable),
    definitions: new PostgresDefinitionStore(durable),
    drafts: new PostgresSetupDraftStore(durable),
    imports: new PostgresEvidenceImportStore(durable),
    // The log takes the connection rather than the `durable` wrapper, because it must not swallow a
    // write failure into `onError` the way a store does: a lost history row is a degraded page, and a
    // lost audit row is a hole in the record. The recorder above it decides what to do with the
    // throw, and it counts them — see `AuditRecorder.unrecorded`.
    audit: new PostgresAuditLog(db),
    improvements,
    notes: new PostgresNoteStore(durable),
    serving: new PostgresServingStore(durable),
    reviews: new PostgresReviewStore({
      ...durable,
      pillars: options.pillars ?? [],
      ...(options.projector != null ? { projector: options.projector } : {}),
    }),
    // The plan's date is read through the improvement store rather than passed in by the caller, for
    // the reason that store's own writer gives: the caller answering an attempt is a scan-completion
    // path, which holds a run and a list of attempts and has no reason to hold plans.
    validations: new PostgresValidationStore({
      ...durable,
      planCreatedAt: async (planId) => (await improvements.plan(planId))?.createdAt,
    }),
    risks: new PostgresRiskStore(durable),
    applicability: new PostgresApplicabilityStore(durable),
    retention: new PostgresRetentionStore(db),
    retentionGateway: new PostgresRetentionGateway(db),
    runs: new PostgresRunStore(db),
    advisories: new PostgresAdvisoryStore(db),
    planExtracts: new PostgresPlanExtractStore(db),
    publications: new PostgresPublicationStore(durable),
    explanation: `Scan history is kept in ${where} and survives restarts.`,
    attestationExplanation: `Answers are kept in ${where} and survive restarts.`,
    decisionExplanation: `Decisions are kept in ${where} and survive restarts.`,
    definitionExplanation: `Assessment definitions are kept in ${where} and survive restarts.`,
    improvementExplanation: `Improvement plans and their actions are kept in ${where} and survive restarts.`,
    noteExplanation: `Notes are kept in ${where} and survive restarts.`,
    servingExplanation: `Serving declarations are kept in ${where} and survive restarts.`,
    reviewExplanation: `Reviews are kept in ${where} and survive restarts.`,
    validationExplanation: `Validations are kept in ${where} and survive restarts.`,
    riskExplanation: `Accepted risks are kept in ${where} and survive restarts.`,
    verify: () => verifyRecords({ db }),
    // `select 1` rather than a read of one of the app's own tables, so a schema that failed to create
    // reports as a database that answers — which it does — and the missing table is a different fault
    // with a different fix. It also wakes nothing and touches no row.
    ping: async () => {
      await db.query('select 1');
    },
    close: () => closeQuietly(db, options.onError),
  };
}

async function closeQuietly(db: Postgres, onError?: (operation: string, error: unknown) => void): Promise<void> {
  try {
    await db.end();
  } catch (error) {
    // Shutdown is not a place to fail. The process is going away and a pool that would not drain
    // cleanly is worth a line in a log and nothing more.
    onError?.('close the database pool', error);
  }
}

const NOT_KEPT =
  `This app is running with ${DEMO_ENV} set, so answers cannot be kept: anything recorded here is lost when ` +
  'the app restarts, which happens on every deploy. Unset it and bind a Lakebase database before answering, ' +
  'or the requirements that can only be answered by a person will keep reporting as unmeasured.';

const DECISIONS_NOT_KEPT =
  `This app is running with ${DEMO_ENV} set, so decisions about findings cannot be kept: an accepted risk, a ` +
  'deferred fix or a claim that something has been fixed is lost when the app restarts, which happens on every ' +
  'deploy. Unset it and bind a Lakebase database before deciding anything, or every run will report the same ' +
  'findings in the same order with no record of the work done against them.';

const PLANS_NOT_KEPT =
  `This app is running with ${DEMO_ENV} set, so an improvement plan cannot be kept. Every plan, every action, ` +
  'every owner and every date somebody agreed to would be gone on the next deploy — and unlike a scan or an ' +
  'answer, there is nothing to reconstruct them from: the estate records what is wrong, not what anybody ' +
  'decided to do about it. Unset it and bind a Lakebase database before planning anything.';

const NOTES_NOT_KEPT =
  `This app is running with ${DEMO_ENV} set, so a note cannot be kept. What somebody noticed while reading a ` +
  'run — that both failures are in an account closing in November, that a pillar looks the way it does on ' +
  'purpose — is gone on the next deploy, and nothing else records that it was ever written. Unset it and bind a ' +
  'Lakebase database before relying on notes.';

const SERVING_NOT_KEPT =
  `This app is running with ${DEMO_ENV} set, so a serving declaration cannot be kept. Which relations ` +
  'this organisation serves, and what it says those must carry, is gone on the next deploy — and every ' +
  'readiness reading names the version it was taken of, so the readings outlive the thing they are ' +
  'readings of. Unset it and bind a Lakebase database before declaring anything.';

const REVIEWS_NOT_KEPT =
  `This app is running with ${DEMO_ENV} set, so a review cannot be kept. Confirming a pillar or skipping one ` +
  'is a judgement with a name on it, and the result that later publication reads would be gone on the next ' +
  'deploy — leaving the scan still showing a score nobody finalised. Unset it and bind a Lakebase database ' +
  'before reviewing.';

const VALIDATIONS_NOT_KEPT =
  `This app is running with ${DEMO_ENV} set, so a validation cannot be kept. An action the app marked verified ` +
  'would keep the state and lose the run behind it, the requirements that were checked, and every attempt that ' +
  'failed before the one that held — which is the part of the record an auditor asks for. Unset it and bind a ' +
  'Lakebase database before relying on a verification.';

const RISKS_NOT_KEPT =
  `This app is running with ${DEMO_ENV} set, so an accepted risk cannot be kept. The requirement would go back on ` +
  'the queue on the next deploy with nothing recording that somebody had considered it, who owns it, what is ' +
  'holding the line instead, or when the acceptance was due to be looked at again — which is worse than never ' +
  'having accepted it, because the work of deciding is lost and the exposure remains. Unset it and bind a ' +
  'Lakebase database before accepting anything.';

const DEFINITIONS_NOT_KEPT =
  `This app is running with ${DEMO_ENV} set, so an assessment definition cannot be kept. Every run would be ` +
  'stamped with a version of something that is gone by the next deploy, leaving finished assessments unable to ' +
  'say what they were of. Unset it and bind a Lakebase database before defining anything.';
