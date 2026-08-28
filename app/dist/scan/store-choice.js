import { InMemoryDefinitionStore } from "../define/store.js";
import { InMemoryEvidenceImportStore, PostgresEvidenceImportStore } from "../import/store.js";
import { InMemoryAuditLog, PostgresAuditLog } from "../store/audit-log.js";
import { InMemoryImprovementStore } from "../improve/store.js";
import { InMemoryServingStore } from "../foundation/serving-store.js";
import { InMemoryValidationStore } from "../validate/store.js";
import { InMemoryRiskStore } from "../accept/store.js";
import { verifyRecords } from "../records/verify.js";
import { InMemoryAttestationStore } from "../attest/store.js";
import { PostgresPublicationStore } from "../monthly/store.js";
import { InMemoryScanStore } from "./store.js";
import { PostgresScanStore } from "./postgres-store.js";
import { PostgresAttestationStore } from "../attest/postgres-store.js";
import { InMemoryDecisionStore, PostgresDecisionStore } from "../decide/store.js";
import { PostgresDefinitionStore } from "../define/postgres-store.js";
import { InMemorySetupDraftStore } from "../define/setup-store.js";
import { PostgresSetupDraftStore } from "../define/setup-postgres-store.js";
import { PostgresImprovementStore } from "../improve/postgres-store.js";
import { InMemoryNoteStore } from "../note/store.js";
import { PostgresNoteStore } from "../note/postgres-store.js";
import { PostgresServingStore } from "../foundation/serving-postgres-store.js";
import { InMemoryReviewStore } from "../review/store.js";
import { PostgresReviewStore } from "../review/postgres-store.js";
import { PostgresValidationStore } from "../validate/postgres-store.js";
import { PostgresRiskStore } from "../accept/postgres-store.js";
import { PostgresApplicabilityStore } from "../apply/postgres-store.js";
import { PostgresRetentionGateway, PostgresRetentionStore } from "../admin/retention-store.js";
import { PostgresRunStore } from "../run/run-store.js";
import { PostgresAdvisoryStore } from "../advise/store.js";
import { PostgresPlanExtractStore } from "../advise/plan-store.js";
import { openPostgres } from "../store/postgres.js";
//#region server/scan/store-choice.ts
/**
* Set to `1` to run with no durable store at all.
*
* Named for what it is rather than what it does. `WAF_EPHEMERAL_STORE=1` would read as a tuning
* knob; this cannot be set by somebody who thinks they are configuring a cache.
*/
const DEMO_ENV = "WAF_DEMO_NO_PERSISTENCE";
/**
* The stores, or a thrown error naming what is unbound.
*
* Throwing rather than degrading is the whole point of this change, and the caller is expected to
* catch it and serve the explanation rather than exit — an app that dies leaves a stack trace in a
* log the person who deployed it may not be able to read. See ADR 0011 and `server.ts`.
*/
async function chooseStore(options = {}) {
	if (((options.env ?? process.env)["WAF_DEMO_NO_PERSISTENCE"] ?? "").trim() === "1") {
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
				...options.projector != null ? { projection: {
					project: options.projector,
					scan: (id) => store.get(id),
					attestation: (id, scope) => attestations.get(id, scope)
				} } : {}
			}),
			validations: new InMemoryValidationStore(),
			risks: new InMemoryRiskStore(),
			explanation: `This app is running with ${DEMO_ENV} set, so nothing is kept. Scan history, attested answers and decisions are held in memory and lost when the app restarts, which happens on every deploy and whenever the platform scales it. Unset it and bind a Lakebase database to keep them.`,
			attestationExplanation: NOT_KEPT,
			decisionExplanation: DECISIONS_NOT_KEPT,
			definitionExplanation: DEFINITIONS_NOT_KEPT,
			improvementExplanation: PLANS_NOT_KEPT,
			noteExplanation: NOTES_NOT_KEPT,
			servingExplanation: SERVING_NOT_KEPT,
			reviewExplanation: REVIEWS_NOT_KEPT,
			validationExplanation: VALIDATIONS_NOT_KEPT,
			riskExplanation: RISKS_NOT_KEPT
		};
	}
	const db = await openPostgres(options);
	const durable = {
		db,
		...options.onError ? { onError: options.onError } : {}
	};
	const where = `the ${db.schema} schema of the bound Lakebase database`;
	const improvements = new PostgresImprovementStore(durable);
	return {
		store: new PostgresScanStore(durable),
		attestations: new PostgresAttestationStore(durable),
		decisions: new PostgresDecisionStore(durable),
		definitions: new PostgresDefinitionStore(durable),
		drafts: new PostgresSetupDraftStore(durable),
		imports: new PostgresEvidenceImportStore(durable),
		audit: new PostgresAuditLog(db),
		improvements,
		notes: new PostgresNoteStore(durable),
		serving: new PostgresServingStore(durable),
		reviews: new PostgresReviewStore({
			...durable,
			pillars: options.pillars ?? [],
			...options.projector != null ? { projector: options.projector } : {}
		}),
		validations: new PostgresValidationStore({
			...durable,
			planCreatedAt: async (planId) => (await improvements.plan(planId))?.createdAt
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
		ping: async () => {
			await db.query("select 1");
		},
		close: () => closeQuietly(db, options.onError)
	};
}
async function closeQuietly(db, onError) {
	try {
		await db.end();
	} catch (error) {
		onError?.("close the database pool", error);
	}
}
const NOT_KEPT = `This app is running with ${DEMO_ENV} set, so answers cannot be kept: anything recorded here is lost when the app restarts, which happens on every deploy. Unset it and bind a Lakebase database before answering, or the requirements that can only be answered by a person will keep reporting as unmeasured.`;
const DECISIONS_NOT_KEPT = `This app is running with ${DEMO_ENV} set, so decisions about findings cannot be kept: an accepted risk, a deferred fix or a claim that something has been fixed is lost when the app restarts, which happens on every deploy. Unset it and bind a Lakebase database before deciding anything, or every run will report the same findings in the same order with no record of the work done against them.`;
const PLANS_NOT_KEPT = `This app is running with ${DEMO_ENV} set, so an improvement plan cannot be kept. Every plan, every action, every owner and every date somebody agreed to would be gone on the next deploy — and unlike a scan or an answer, there is nothing to reconstruct them from: the estate records what is wrong, not what anybody decided to do about it. Unset it and bind a Lakebase database before planning anything.`;
const NOTES_NOT_KEPT = `This app is running with ${DEMO_ENV} set, so a note cannot be kept. What somebody noticed while reading a run — that both failures are in an account closing in November, that a pillar looks the way it does on purpose — is gone on the next deploy, and nothing else records that it was ever written. Unset it and bind a Lakebase database before relying on notes.`;
const SERVING_NOT_KEPT = `This app is running with ${DEMO_ENV} set, so a serving declaration cannot be kept. Which relations this organisation serves, and what it says those must carry, is gone on the next deploy — and every readiness reading names the version it was taken of, so the readings outlive the thing they are readings of. Unset it and bind a Lakebase database before declaring anything.`;
const REVIEWS_NOT_KEPT = `This app is running with ${DEMO_ENV} set, so a review cannot be kept. Confirming a pillar or skipping one is a judgement with a name on it, and the result that later publication reads would be gone on the next deploy — leaving the scan still showing a score nobody finalised. Unset it and bind a Lakebase database before reviewing.`;
const VALIDATIONS_NOT_KEPT = `This app is running with ${DEMO_ENV} set, so a validation cannot be kept. An action the app marked verified would keep the state and lose the run behind it, the requirements that were checked, and every attempt that failed before the one that held — which is the part of the record an auditor asks for. Unset it and bind a Lakebase database before relying on a verification.`;
const RISKS_NOT_KEPT = `This app is running with ${DEMO_ENV} set, so an accepted risk cannot be kept. The requirement would go back on the queue on the next deploy with nothing recording that somebody had considered it, who owns it, what is holding the line instead, or when the acceptance was due to be looked at again — which is worse than never having accepted it, because the work of deciding is lost and the exposure remains. Unset it and bind a Lakebase database before accepting anything.`;
const DEFINITIONS_NOT_KEPT = `This app is running with ${DEMO_ENV} set, so an assessment definition cannot be kept. Every run would be stamped with a version of something that is gone by the next deploy, leaving finished assessments unable to say what they were of. Unset it and bind a Lakebase database before defining anything.`;
//#endregion
export { DEMO_ENV, chooseStore };
