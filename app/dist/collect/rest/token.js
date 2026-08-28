//#region server/collect/rest/token.ts
/**
* Scopes named by an OAuth access token, or nothing if it does not say.
*
* The signature is deliberately not `verify`. This decodes without checking anything, which
* is unsafe for an authorisation decision and fine for the only use here: reporting to the
* signed-in user what the token they supplied claims to permit. Nothing branches on the
* result except a diagnostic page — the authority to make each call is decided by the
* platform when the call is made, as it must be.
*
* Returns nothing rather than throwing for an opaque token, since a non-JWT token is a
* legitimate thing for the platform to issue and not an error to report.
*/
function scopesOf(token) {
	const payload = claimsOf(token);
	if (payload == null) return void 0;
	const scope = payload["scope"] ?? payload["scp"];
	if (typeof scope === "string") return scope.split(/[\s,]+/u).filter((part) => part !== "");
	if (Array.isArray(scope)) return scope.filter((part) => typeof part === "string");
}
/** Unverified claims of a JWT, or nothing if it is not one. */
function claimsOf(token) {
	const parts = token.split(".");
	if (parts.length !== 3) return void 0;
	const body = parts[1];
	if (body == null) return void 0;
	try {
		const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		return typeof decoded === "object" && decoded !== null ? decoded : void 0;
	} catch {
		return;
	}
}
function reportOn(token, now = /* @__PURE__ */ new Date()) {
	const claims = claimsOf(token);
	if (claims == null) return { readable: false };
	const scopes = scopesOf(token);
	const expiry = typeof claims["exp"] === "number" ? claims["exp"] : void 0;
	const audience = claims["aud"];
	return {
		readable: true,
		...scopes != null ? { scopes } : {},
		...expiry != null ? { expiresIn: Math.round(expiry - now.getTime() / 1e3) } : {},
		...typeof audience === "string" ? { audience } : {}
	};
}
//#endregion
export { claimsOf, reportOn, scopesOf };
