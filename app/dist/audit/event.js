//#region server/audit/event.ts
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
const AUDIT_ACTIONS = [
	"scan.start",
	"scan.cancel",
	"advisory.start",
	"advisory.cancel",
	"schedule.trigger",
	"attestation.record",
	"decision.record",
	"definition.create",
	"definition.revise",
	"definition.archive",
	"definition.unarchive",
	"definition.preflight",
	"draft.read",
	"draft.save",
	"draft.discard",
	"scope.preview",
	"plan.open",
	"plan.close",
	"action.raise",
	"action.revise",
	"action.move",
	"validation.request",
	"validation.withdraw",
	"risk.accept",
	"risk.revoke",
	"applicability.record",
	"applicability.revoke",
	"note.write",
	"serving.declare",
	"review.open",
	"review.confirm",
	"review.skip",
	"review.answer",
	"evidence.import",
	"export.scan",
	"export.plan",
	"retention.configure",
	"retention.hold",
	"retention.release",
	"retention.sweep",
	"retention.reset",
	"month.publish",
	"month.supersede"
];
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
const AUDIT_PHRASES = {
	"scan.start": "start a scan",
	"scan.cancel": "cancel the running scan",
	"advisory.start": "ask the advisor to look at the workload",
	"advisory.cancel": "cancel the running advisory run",
	"schedule.trigger": "start the scheduled assessment by hand",
	"attestation.record": "answer a requirement",
	"decision.record": "decide a finding",
	"definition.create": "create an assessment",
	"definition.revise": "revise an assessment",
	"definition.archive": "archive an assessment",
	"definition.unarchive": "put an archived assessment back",
	"definition.preflight": "check what an assessment would read",
	"draft.read": "read an unfinished assessment",
	"draft.save": "save an unfinished assessment",
	"draft.discard": "discard an unfinished assessment",
	"scope.preview": "preview an assessment scope",
	"plan.open": "open an improvement plan",
	"plan.close": "close an improvement plan",
	"action.raise": "raise an action",
	"action.revise": "revise an action",
	"action.move": "move an action to another state",
	"validation.request": "ask for claimed work to be validated by a run",
	"validation.withdraw": "withdraw a claim waiting to be validated",
	"risk.accept": "accept a requirement being unmet for a while",
	"risk.revoke": "end an accepted risk early",
	"applicability.record": "take a requirement out of the score as not applicable or disabled",
	"applicability.revoke": "put a requirement excluded from the score back into it",
	"note.write": "write a note",
	"serving.declare": "declare which data this organisation serves",
	"review.open": "open a review of a run",
	"review.confirm": "confirm a pillar is still current",
	"review.skip": "skip a pillar",
	"review.answer": "answer a requirement while reviewing its pillar",
	"evidence.import": "import collected evidence",
	"export.scan": "export a run",
	"export.plan": "export an improvement plan",
	"retention.configure": "set how long records are kept",
	"retention.hold": "place a legal hold",
	"retention.release": "lift a legal hold",
	"retention.sweep": "remove records that are past their retention period",
	"retention.reset": "delete this install's assessment data",
	"month.publish": "publish a month",
	"month.supersede": "publish a correction to a month"
};
/**
* What the first event's `previous` points at.
*
* A constant rather than an empty string, so an empty `previous` reads as a missing value and never
* as a legitimate start of chain. The bytes are the algorithm's zero digest, which is a value no
* event can have.
*/
const GENESIS = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
//#endregion
export { AUDIT_ACTIONS, AUDIT_PHRASES, GENESIS };
