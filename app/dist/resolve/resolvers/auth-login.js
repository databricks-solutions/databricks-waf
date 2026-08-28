import { agreeing, evidenceFrom, fromSignal, unmeasured } from "./helpers.js";
//#region server/resolve/resolvers/auth-login.ts
const AUTH = "sql:security.auth_login_paths";
/** The action names outside the three, as a clause that reports them and concludes nothing. */
function otherPaths(paths) {
	if (paths.otherAuthEvents === 0) return "";
	const { noun } = agreeing(paths.otherAuthEvents, "event");
	return `${noun} under other action names mentioning login or authentication${paths.otherAuthActions.length === 0 ? "" : ` (${paths.otherAuthActions.join(", ")})`}`;
}
/** Account-level events, which belong to no workspace and are counted rather than dropped. */
function accountPlane(paths) {
	if (paths.accountPlaneEvents === 0) return "";
	const { noun } = agreeing(paths.accountPlaneEvents, "event");
	return `${noun} recorded against the account rather than a workspace`;
}
const AUTH_LOGIN_RESOLVERS = [fromSignal(AUTH, ["SCP-01-01"], (paths, context) => {
	const aside = [otherPaths(paths), accountPlane(paths)].filter((clause) => clause !== "");
	if (paths.passwordLogins > 0) {
		const when = paths.lastPasswordLogin == null ? "" : `, most recently ${paths.lastPasswordLogin.toISOString().slice(0, 10)}`;
		const logins = agreeing(paths.passwordLogins, "username-and-password login");
		const actors = agreeing(paths.passwordActors, "actor");
		return {
			outcome: "fail",
			evidence: [evidenceFrom(context, AUTH, `${logins.noun} from ${actors.noun} in the window` + when + `; ${paths.samlLogins.toLocaleString("en-US")} SAML and ${paths.oidcLogins.toLocaleString("en-US")} OAuth` + (aside.length > 0 ? `; ${aside.join(", and ")}` : ""), "Accounts authenticate through the identity provider rather than with a local password")],
			outcomeReason: "A username-and-password login is its own audit action, distinct from SAML and OAuth. Seeing one means a local credential was used; the account-plane configuration that would say whether such accounts are still provisioned is unreadable here."
		};
	}
	if (paths.loginEvents === 0) return unmeasured(`${paths.otherAuthEvents === 0 ? "No login, SAML or OAuth authentication events were recorded in the window" : `No login, SAML or OAuth authentication events were recorded in the window, though ${otherPaths(paths)} ${paths.otherAuthEvents === 1 ? "was" : "were"}. This reading does not say which of those are people signing in, so it cannot tell whether one of them was a local credential`}, so whether local credentials exist could not be determined from the audit log. Absence of password logins would not prove they do not exist either — only that none authenticated that way while this window was retained.`, "attestation");
	const sso = paths.samlLogins + paths.oidcLogins;
	return unmeasured(`No username-and-password logins were recorded among ${agreeing(paths.loginEvents, "login, SAML or OAuth event").noun} in the window` + (sso > 0 ? ` (${paths.samlLogins.toLocaleString("en-US")} SAML, ${paths.oidcLogins.toLocaleString("en-US")} OAuth)` : "") + (aside.length > 0 ? `, alongside ${aside.join(", and ")}` : "") + ". That settles nothing about whether local accounts exist — only that none authenticated with a password while this window was retained. The account-plane provisioning path is unreadable here.", "attestation");
})];
//#endregion
export { AUTH_LOGIN_RESOLVERS };
