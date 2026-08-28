import { COMPLETE } from "../collect/signal.js";
import { asDate, asSettingValue } from "../collect/rest/probes.js";
import { SURFACES } from "../scan/surfaces.js";
//#region server/import/signals.ts
/**
* The workspace settings, as fifteen controls read them.
*
* The distinction this rebuilds is the one the whole settings table exists for. A key the endpoint
* answered with `null` was never set by this workspace; a key it did not answer at all is a key this
* workspace's cloud or tier does not have. The script preserves both — a null value for the first, an
* absent field for the second — and both must survive the crossing, because a resolver that read them
* as the same thing would report "not configured" for a setting that cannot exist here.
*/
const workspaceSettings = (probe) => {
	const answered = asObject(probe.value);
	const values = /* @__PURE__ */ new Map();
	const unanswered = [];
	for (const key of probe.fields) {
		if (!(key in answered)) {
			unanswered.push(key);
			continue;
		}
		values.set(key, asSettingValue(answered[key]));
	}
	return {
		values,
		unanswered
	};
};
/**
* The personal access tokens, as three controls read them.
*
* `expiresAt` absent is the finding rather than a gap: the endpoint omits an expiry for a token that
* never expires, and two of these controls are looking for exactly that. So an absent field must
* revive as `undefined` and not as a date, which is why every timestamp goes through the same
* coercion the collector uses.
*/
const tokenInventory = (probe) => {
	const answered = asObject(probe.value);
	return {
		tokens: (Array.isArray(answered.token_infos) ? answered.token_infos : []).map((entry) => {
			const token = asObject(entry);
			return {
				id: asId(token.token_id),
				createdBy: asText(token.created_by_username),
				comment: asText(token.comment),
				createdAt: asDate(asEpoch(token.creation_time)),
				expiresAt: asDate(asEpoch(token.expiry_time))
			};
		}),
		truncated: false
	};
};
/**
* The revivers, by signal.
*
* Deliberately a small map rather than a generic decoder. A generic one would accept every signal in
* the file, which reads as progress and is the failure mode described at the top: a resolver handed a
* plain object where it expected a `Map` finds nothing and reports a compliant workspace as a broken
* one. Adding a signal here is a deliberate act with a test beside it.
*/
const REVIVERS = /* @__PURE__ */ new Map([["rest:workspace:preview.workspace-conf", workspaceSettings], ["rest:workspace:token.list", tokenInventory]]);
/**
* The readings an import offers a scan.
*
* Takes the stored import rather than the envelope because the provenance names who collected it and
* when it was imported, and a reading that could not say whose authority produced it would be
* unattributable — which is the one thing an imported number may not be.
*/
function readingsFrom(imported) {
	const signals = /* @__PURE__ */ new Map();
	const unrevived = /* @__PURE__ */ new Set();
	for (const probe of imported.envelope.probes) for (const name of probe.signals) {
		if (!signalled(name)) {
			unrevived.add(name);
			continue;
		}
		const reviver = REVIVERS.get(name);
		if (reviver == null) {
			unrevived.add(name);
			continue;
		}
		const revived = resultFrom(name, probe, reviver, imported.envelope);
		if (preferred(signals.get(name), revived)) signals.set(name, revived);
	}
	return {
		signals,
		unrevived: [...unrevived]
	};
}
/**
* Whether a second reading of the same signal should replace the first.
*
* Two probes in one file can name the same signal, because a signal is a fact and more than one API
* can carry it — and the script does not deduplicate, on purpose: what it collected is what it wrote
* down. So the choice lands here, and it is not "the last one wins". A refusal arriving after a
* reading would erase the reading and turn a measured requirement into an unmeasured one, which is
* the wrong direction for a file that demonstrably contains the answer.
*
* A reading beats a refusal. Otherwise the first stands, because there is nothing in the file that
* makes the second of two equally-good readings the better one, and preferring the later would make
* the result depend on probe order in a file this app did not write.
*/
function preferred(held, arriving) {
	if (held == null) return true;
	return held.status === "unmeasurable" && arriving.status !== "unmeasurable";
}
/**
* Whether a name in the file is a signal id at all.
*
* The envelope validation checks that the signal names are non-empty strings and stops there, on
* purpose: a file from a newer script naming a signal this build has never heard of is a file to hold,
* not a file to refuse. So the narrowing happens here, where an unrecognised name has somewhere
* harmless to go.
*/
function signalled(name) {
	const colon = name.indexOf(":");
	return colon > 0 && SURFACES.includes(name.slice(0, colon));
}
function resultFrom(id, probe, reviver, envelope) {
	const provenance = provenanceFor(probe, envelope);
	const base = {
		id,
		coverage: COMPLETE,
		collectedAt: new Date(envelope.generatedAt),
		durationMs: 0,
		provenance
	};
	if (probe.status !== "observed") return {
		...base,
		status: "unmeasurable",
		unmeasurableReason: refusalOf(probe)
	};
	return {
		...base,
		status: "observed",
		value: reviver(probe)
	};
}
/**
* Why the administrator could not read it either, in their words rather than the app's.
*
* A denial the admin hit is more informative than the app's own, because it rules out the explanation
* a reader would otherwise reach for: that the app lacked a scope somebody could grant it. So the
* message names the tier and keeps the control plane's detail.
*/
function refusalOf(probe) {
	const where = probe.tier === "account" ? "the account console" : "the workspace";
	const said = probe.detail ?? "no reason given";
	return `An administrator's own reading of ${where} ${probe.status === "denied" ? "refused" : probe.status === "skipped" ? "did not attempt" : "failed"} this: ${said}`;
}
/**
* The authority an imported reading was made under.
*
* `admin-cli` and not the app's execution mode, because that is the fact a disputed number turns on:
* this was read by a person at a terminal, holding permissions the app does not hold and cannot
* check, and it is the reason the resulting evidence is classed `admin-collected`. The actor is the
* username the CLI reported, or the tier's own name when the CLI would not say — an account profile
* has no username to give, which is a caveat the import surface already prints.
*/
function provenanceFor(probe, envelope) {
	const identity = envelope.tiers[probe.tier].identity;
	return {
		surface: "rest",
		collector: `admin-script:${probe.label}`,
		authority: "admin-cli",
		actor: identity?.username ?? `an unnamed ${probe.tier} administrator`,
		...identity?.host != null ? { from: identity.host } : {}
	};
}
/**
* The map a scan resolves against, with imported readings filling only what it did not read itself.
*
* The rule is `mayDecideOver` expressed over signals rather than findings, and it is one-directional
* in both halves. An observation the app made stands: a file cannot overwrite a live reading, however
* recent the file claims to be, because the app can re-run its own reading and cannot re-run the
* import. But an import does replace an *unmeasurable* — a signal the app tried and was refused is
* exactly the gap the import exists to fill, and leaving the refusal in place would mean importing
* evidence changed nothing.
*/
function merged(collected, imported) {
	const merged = new Map(collected);
	for (const [id, incoming] of imported) {
		const existing = merged.get(id);
		if (existing == null) {
			merged.set(id, incoming);
			continue;
		}
		if (existing.status === "unmeasurable" && incoming.status === "observed") merged.set(id, incoming);
	}
	return merged;
}
function asObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
/**
* An identifier from an untrusted file, as a string.
*
* Only primitives are converted. The collector can write `String(token.token_id)` because the SDK
* types say what it is; here the value came out of a file, and stringifying an object would put
* `[object Object]` into a finding as if it were a token id.
*/
function asId(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}
function asText(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/** Epoch milliseconds as the file carries them: a number, or a string when JSON round-tripping made one. */
function asEpoch(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
}
//#endregion
export { merged, readingsFrom };
