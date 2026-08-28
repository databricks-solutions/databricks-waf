import { digestOf as digestOf$1, sameDigest } from "../records/digest.js";
/**
* `sha256:<hex>` over the canonical form, the same way the script computes it over the same value.
*
* Re-exported from `records/digest.ts` rather than reimplemented. The app already has one digest
* function over canonical bytes, and the whole reason this comparison works across two languages is
* that there is one rule; a second implementation of it here would be a third.
*/
function digestOf(value) {
	return digestOf$1(value);
}
function plural(count, one, many) {
	return count === 1 ? one : many;
}
/** Age in whole hours, floored, and never negative — a future file's age is reported as its refusal. */
function hoursBetween(then, now) {
	return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 36e5));
}
/**
* Whether the bytes are the bytes that were collected.
*
* Recomputed over the probes alone, because that is what the script digests: the envelope's own
* metadata is outside it on purpose, so re-serialising the file — which any tool between the admin
* and here may do — cannot invalidate the evidence, while editing a reading does.
*
* This is the check that makes the rest of them worth making. Without it, `generated_at` and the
* identity block are editable, so freshness and targeting are assertions by whoever holds the file.
*/
function checkDigest(envelope, refusals) {
	const recomputed = digestOf(envelope.probes);
	if (!sameDigest(recomputed, envelope.digest)) refusals.push({
		reason: "digest-mismatch",
		message: `The readings in this file do not match the digest the script recorded over them, so at least one has changed since it was collected. The file says ${envelope.digest} and its readings digest to ${recomputed}. Collect it again rather than editing it — reformatting the file is safe, changing a reading is not.`
	});
	return recomputed;
}
function checkAge(envelope, now, refusals, cautions) {
	const generated = new Date(Date.parse(envelope.generatedAt));
	if (generated.getTime() > now.getTime() + 10 * 6e4) {
		refusals.push({
			reason: "future",
			message: `This file says it was collected at ${envelope.generatedAt}, which is ahead of this workspace's clock by more than ${String(10)} minutes. Its age cannot be established, and an age that cannot be established cannot expire. Check the clock on the machine that ran the script.`
		});
		return 0;
	}
	const ageHours = hoursBetween(generated, now);
	const ageDays = Math.floor(ageHours / 24);
	if (ageDays >= 30) refusals.push({
		reason: "expired",
		message: `This file was collected ${String(ageDays)} days ago, and evidence is accepted for ${String(30)}. The settings it covers are ones an estate changes deliberately, so an older reading is not evidence of the present. Run the script again.`
	});
	else if (ageDays >= 15) cautions.push({
		reason: "stale",
		message: `Collected ${String(ageDays)} days ago, so it expires in ${String(30 - ageDays)}. Findings from it describe the estate as it was that day.`
	});
	return ageHours;
}
/**
* Whether this file is about this estate.
*
* Both halves are conditional on the app knowing what to compare against, and an unverified target is
* a caution rather than a pass. The alternative — refusing until a scan has run — would make the
* import unusable in the case it is most needed, which is a first assessment where the account-plane
* requirements have never been answered.
*/
function checkTarget(envelope, target, refusals, cautions) {
	const workspace = envelope.tiers.workspace.identity;
	const claimed = envelope.tiers.account.identity?.accountId ?? workspace?.accountId;
	if (target?.accountId != null && claimed != null && claimed !== target.accountId) refusals.push({
		reason: "wrong-account",
		message: `This file was collected against account ${claimed} and this app is assessing ${target.accountId}. Findings from it would describe a different estate.`
	});
	const collectedFrom = workspace?.workspaceId;
	const covered = target?.workspaceIds;
	if (collectedFrom != null && covered != null && covered.length > 0 && !covered.includes(collectedFrom)) refusals.push({
		reason: "wrong-workspace",
		message: `The workspace half of this file was collected against workspace ${collectedFrom}, which is not one of the ${String(covered.length)} ${plural(covered.length, "workspace", "workspaces")} this assessment covers. Its workspace-level readings describe somewhere else.`
	});
	if ((target?.accountId == null || claimed == null) && (covered == null || covered.length === 0 || collectedFrom == null) && refusals.length === 0) cautions.push({
		reason: "target-unverified",
		message: "Nothing here establishes that this file describes the estate under assessment: the app does not yet know which account and workspaces it is measuring, so the identity in the file was read rather than checked. Run an assessment first and the same file will be checked against it."
	});
}
function checkTiers(envelope, refusals, cautions) {
	const { workspace, account } = envelope.tiers;
	if (!workspace.ran && !account.ran) {
		refusals.push({
			reason: "nothing-collected",
			message: "Neither authority tier ran, so every probe in this file was skipped and there is nothing in it to import. Run the script with --profile, and with --account-profile as well for the account-level requirements."
		});
		return;
	}
	for (const [name, tier] of [["workspace", workspace], ["account", account]]) {
		if (tier.ran && tier.identity?.username == null) cautions.push({
			reason: "unattributed",
			message: `The ${name} tier records no collecting user, so these readings cannot be attributed to a person. ` + (name === "account" ? "That is expected: the CLI cannot resolve an identity for an account profile, and the account plane has no endpoint that names the caller. The account id and host are recorded, and who ran it is not." : "That is not expected for a workspace profile, and it is worth establishing who ran this before relying on it.")
		});
		if (!tier.ran) {
			const affected = envelope.probes.filter((probe) => probe.tier === name);
			const controls = new Set(affected.flatMap((probe) => probe.controls));
			cautions.push({
				reason: "tier-not-run",
				message: `The ${name} tier was not run, so ${String(controls.size)} ${plural(controls.size, "requirement", "requirements")} across ${String(affected.length)} ${plural(affected.length, "call", "calls")} stay unanswered. ` + (tier.reason ?? `Run the script again with a ${name} profile to answer them.`)
			});
		}
	}
}
function checkScript(envelope, published, cautions) {
	if (published == null || published === envelope.script.digest) return;
	cautions.push({
		reason: "script-differs",
		message: `This file was collected by a copy of ${envelope.script.name} version ${envelope.script.version} whose digest is ${envelope.script.digest}, and the copy this app publishes digests to ${published}. That is expected if the app was updated after the collection. If it was not, the script that ran was not the one published here, and what it read is worth checking before acting on it.`
	});
}
function checkProbes(envelope, cautions) {
	const refused = envelope.probes.filter((probe) => probe.status === "denied" || probe.status === "error");
	if (refused.length === 0) return;
	cautions.push({
		reason: "probes-refused",
		message: `${String(refused.length)} ${plural(refused.length, "call was", "calls were")} refused or failed, so the requirements behind them are unmeasured rather than passing. Each one records what the API said: ` + refused.map((probe) => `${probe.label} (${probe.status})`).join(", ") + "."
	});
}
/**
* The refusal a replay earns, named so both paths that can detect one say the same thing.
*
* There are two, and only one of them runs this check: the digest read below, and the unique index at
* insert time that catches the pair of uploads which raced past it. The route turning that violation
* into a response needs the identical refusal, and a second copy of this sentence would be one edit
* away from the two paths explaining the same event differently.
*/
const REPLAYED = {
	reason: "replayed",
	message: "These exact readings have been imported before. Importing them again would record a second collection where one happened, which is how a stale posture comes to look like a maintained one. Run the script again for a current reading."
};
function checkReplay(digest, imported, refusals) {
	if (imported?.has(digest) !== true) return;
	refusals.push(REPLAYED);
}
/**
* Every reason to refuse this envelope, and everything about it worth saying out loud.
*
* Ordered so that the digest check runs first, because every other check reads a field the digest is
* what makes trustworthy. They still all run — a file can be both edited and expired, and saying so
* costs nothing — but the order is the order a reader should think in.
*/
function assess(input) {
	const { envelope, target, imported, publishedScriptDigest, now = /* @__PURE__ */ new Date() } = input;
	const refusals = [];
	const cautions = [];
	const digest = checkDigest(envelope, refusals);
	checkReplay(digest, imported, refusals);
	const ageHours = checkAge(envelope, now, refusals, cautions);
	checkTiers(envelope, refusals, cautions);
	checkTarget(envelope, target, refusals, cautions);
	checkScript(envelope, publishedScriptDigest, cautions);
	checkProbes(envelope, cautions);
	return {
		trusted: refusals.length === 0,
		refusals,
		cautions,
		digest,
		ageHours
	};
}
//#endregion
export { REPLAYED, assess, digestOf };
