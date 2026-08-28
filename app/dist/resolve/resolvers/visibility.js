import { observedValue } from "./helpers.js";
//#region server/resolve/resolvers/visibility.ts
const LINEAGE = "sql:uc.lineage_coverage";
const PLATFORM = "sql:uc.platform_census";
/**
* The signal a resolver has to declare before `unestablishedEmptiness` can tell it anything.
*
* Exported because the scan plan collects exactly what resolvers ask for, so a resolver that calls
* the cross-check without declaring this enrichment is never given the reading and always takes the
* absent branch. That branch is safe — it declines to assert the emptiness either way — so the
* failure is silent, which is why the constant is shared rather than the string repeated.
*/
const VISIBILITY_CROSS_CHECK = LINEAGE;
/**
* What the reader would have to do to make the catalogue readable, where it is not.
*
* `grant` rather than `attest`: this is a privilege on the customer's own metastore, issuable by
* their admin in one statement, which is the distinction `RemedyKind` draws. It carries no
* `because` because there is no refusal to quote — the statement succeeded and returned zeroes,
* which is exactly why nothing else in the app can classify this.
*/
const BROWSE_REMEDY = {
	kind: "grant",
	says: "Grant BROWSE on the customer catalogs to the identity this scan runs as, which makes their metadata readable without granting access to any row. For a scheduled run, `npm run schedule:principal -- --catalogs all --apply` derives the catalogs and prints the statements before it issues them.",
	signals: [LINEAGE]
};
/**
* Whether this scan may say the metastore is empty, or only that it read nothing.
*
* Returns a resolution where the emptiness is unestablished, and `undefined` where the reading can
* be trusted — so a caller reads as `unestablishedEmptiness(context) ?? notApplicable(...)`.
*
* Absent lineage counts as unestablished, and that is deliberate rather than an oversight about a
* workspace with system tables switched off. The worst case this exists for is a principal holding
* nothing at all, and such a principal may be unable to read `system.access` either — so treating a
* missing cross-check as permission to assert emptiness would leave the defect intact in precisely
* the case that produced it. The cost is that a genuinely empty estate with no lineage collected
* reports these requirements unmeasured rather than not-applicable, which understates coverage and
* overstates nothing.
*/
function unestablishedEmptiness(context) {
	const lineage = observedValue(context, LINEAGE);
	if (lineage == null) return {
		outcome: "unmeasurable",
		evidence: [],
		unmeasured: "unreadable",
		remedy: BROWSE_REMEDY,
		outcomeReason: "No tables were visible to the identity that ran this scan. `system.information_schema` reports only the objects its reader holds a privilege on, and the lineage reading that would corroborate an empty metastore was not collected, so this scan cannot tell an empty estate from an unreadable one."
	};
	if (lineage.lineageEvents === 0) return void 0;
	return {
		outcome: "unmeasurable",
		evidence: [],
		unmeasured: "unreadable",
		remedy: BROWSE_REMEDY,
		outcomeReason: `No tables were visible to the identity that ran this scan, while lineage over the same catalogs recorded ${lineage.lineageEvents.toLocaleString("en-US")} events across ${lineage.tablesWithLineage.toLocaleString("en-US")} tables in the window. \`system.information_schema\` reports only the objects its reader holds a privilege on, so the two readings disagree and this scan cannot establish that the estate is empty.`
	};
}
/**
* The four metastore objects whose census count is filtered per object type.
*
* Each is recovered by its own metastore-level grant and by nothing else, measured one privilege at
* a time on labs 2026-08-10 — `docs/plan/e1-populations.md`, phase E1f. `BROWSE`, which recovers the
* catalogue readings above, recovers none of these; the scheduled principal read 0 providers of 1
* and 0 connections of 1 with it in place.
*
* Connections can also be granted per object. That is not modelled here because a per-object set is
* only complete on the day it is issued, and a count is a claim about all of them.
*/
const SHARING_GRANT = {
	shares: {
		grant: "USE SHARE",
		column: "USE_SHARE"
	},
	recipients: {
		grant: "USE RECIPIENT",
		column: "USE_RECIPIENT"
	},
	providers: {
		grant: "USE PROVIDER",
		column: "USE_PROVIDER"
	},
	connections: {
		grant: "USE CONNECTION",
		column: "USE_CONNECTION"
	}
};
/**
* Both spellings, written out rather than derived, because the two surfaces disagree about the
* separator: `metastore_privileges` returns `USE_SHARE` and `GRANT`/`SHOW GRANTS` take `USE SHARE`.
* Deriving one from the other worked for these four and would have been wrong for the first
* privilege whose name has two spaces in it.
*/
function held(platform, kind) {
	return platform.sharingPrivileges.includes(SHARING_GRANT[kind].column);
}
/**
* Which of these counts this identity has not established it can see.
*
* Two ways to establish it, and the second is why this is not simply a privilege test: the metastore
* owner reads all four while holding none of the four grants, so an owner's zero is a real zero.
* Measured — `metastore_privileges` returned nothing at all for the owner on labs.
*
* An account admin who does not own the metastore is neither, and is not covered. That case was not
* measured, so the resolutions below report the two fields that were read rather than concluding
* what such a reader can see.
*/
function unseenSharing(platform, kinds) {
	if (platform.ownsMetastore) return [];
	return kinds.filter((kind) => !held(platform, kind));
}
/** English for a list, so a reason can name one, two or three grants without a plural bug. */
function joined(words) {
	if (words.length <= 1) return words[0] ?? "";
	return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1] ?? ""}`;
}
/**
* Whether this scan may read a zero sharing count as an estate that does not share.
*
* Same contract as `unestablishedEmptiness`: a resolution where the zero is unestablished, and
* `undefined` where it can be trusted, so a caller reads it as
* `unestablishedSharing(...) ?? notApplicable(...)`.
*
* `counts` names what this scan read, in the caller's own words, so that the two sentences a reader
* sees describe the same set. Callers pass the readings themselves rather than "nothing", because a
* partly-granted identity gets here with some of them non-zero.
*/
function unestablishedSharing(platform, kinds, counts) {
	const unseen = unseenSharing(platform, kinds);
	if (unseen.length === 0) return void 0;
	const grants = unseen.map((kind) => SHARING_GRANT[kind].grant);
	return {
		outcome: "unmeasurable",
		evidence: [],
		unmeasured: "unreadable",
		remedy: {
			kind: "grant",
			says: `Grant ${joined(grants)} on the metastore to the identity this scan runs as. ${grants.length === 1 ? "It makes" : "Each of them makes"} its own count readable. Measured on labs: an identity holding all four of the sharing grants was still refused \`CREATE FOREIGN CATALOG\` on a connection they had made visible.` + (unseen.includes("connections") ? " `USE CONNECTION` also exposed that connection’s URL, which for a federated connection is the hostname of the source system." : ""),
			signals: [PLATFORM]
		},
		outcomeReason: `This scan read ${counts}. The identity it ran as does not own this metastore, and was not granted ${joined(grants)} — ${grants.length === 1 ? "the privilege" : "the privileges"} ${grants.length === 1 ? "that reading is" : "those readings are"} filtered by. So it cannot tell an estate that has none from one whose sharing configuration it was not granted sight of.`
	};
}
//#endregion
export { VISIBILITY_CROSS_CHECK, unestablishedEmptiness, unestablishedSharing };
