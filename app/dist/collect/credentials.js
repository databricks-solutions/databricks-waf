//#region server/collect/credentials.ts
/**
* The header Databricks Apps injects when a request carries a user token.
*
* Named here rather than inline at the call site because it is the entire
* mechanism by which on-behalf-of-user works, and a typo in it degrades silently to
* the app's own identity — which would still work, would return more data than the
* user is entitled to, and would pass every test that did not check whose eyes the
* results came from.
*/
const USER_TOKEN_HEADER = "x-forwarded-access-token";
/**
* Headers the Apps proxy sets alongside the token, naming who it belongs to.
*
* Preferred over asking the SCIM current-user endpoint, which is a network round
* trip on the scan path to learn something already in the request, and which needs
* a scope this app does not request. The first live scan stamped its actor as
* "unknown" for exactly that reason: the call was made, was refused, and the
* failure was swallowed by design.
*
* Email first because it is the identity a workspace admin recognises in an audit
* log; the preferred username is the fallback for identities without one.
*/
const USER_IDENTITY_HEADERS = ["x-forwarded-email", "x-forwarded-preferred-username"];
/**
* The workspace URL, as an absolute URL whatever form the environment supplied.
*
* The Apps runtime sets `DATABRICKS_HOST` to a bare hostname —
* `dbc-….cloud.databricks.com`, no scheme — while the CLI and the SDKs set it with
* `https://`. Both are "the host", and `fetch` accepts only one of them: the bare form
* fails with "Failed to parse URL", which surfaced as every check in a live scan
* reporting that it could not be measured. Normalising once at the edge means no caller
* has to know which runtime it is in.
*/
function workspaceHost(env = process.env) {
	const raw = (env.DATABRICKS_HOST ?? env.DATABRICKS_WORKSPACE_URL ?? "").trim();
	if (raw === "") return "";
	return (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
}
/** Who the forwarded token belongs to, according to the proxy that forwarded it. */
function actorFromHeaders(request) {
	for (const header of USER_IDENTITY_HEADERS) {
		const value = headerValue(request, header)?.trim();
		if (value != null && value !== "") return value;
	}
}
/**
* A service principal's forwarded identity, which is its application id and so a UUID.
*
* Measured rather than assumed, on labs, 2026-08-10: of the twenty stored scans, the nine scheduled
* runs all carry `5af463d1-8cb9-4417-b2a5-725cea64cce5` as their actor and the eleven interactive
* ones all carry `operator@example.com`. The two forms do not overlap in either
* direction — an email cannot be a UUID, and an application id is nothing else.
*
* The client reached the same rule from the other end and for the same reason, in
* `pages/run-language.ts`, where three surfaces had inferred "a person" from an execution mode that
* was always `on-behalf-of-user`. `credentials.test.ts` holds the two copies to the same answers.
*/
const APPLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
* Which kind of identity the proxy forwarded, from the identity itself.
*
* `fromRequest` used to write `on-behalf-of-user` unconditionally, so every scan ever recorded said
* it — including eight scheduled runs with no person anywhere in them. The field is not decorative:
* `comparable()` refuses to compare two runs across a change of execution mode, and that refusal
* could not fire while the value never varied.
*
* Nothing rewrites what is already stored. A stamp records what the app believed when it wrote it.
*/
function modeFor(actor) {
	return APPLICATION_ID.test(actor.trim()) ? "service-principal" : "on-behalf-of-user";
}
var MissingUserTokenError = class extends Error {
	constructor() {
		super(`No ${USER_TOKEN_HEADER} header on the request. On-behalf-of-user scans require it, and falling back to the app identity is refused deliberately: it would return more than the caller is entitled to see.`);
		this.name = "MissingUserTokenError";
	}
};
function headerValue(request, name) {
	const raw = request.headers[name] ?? request.headers[name.toLowerCase()];
	if (raw == null) return void 0;
	return Array.isArray(raw) ? raw[0] : raw;
}
/** Named Unity Catalog service credential this install may vend cloud keys from. */
const SERVICE_CREDENTIAL_ENV = "WAF_SERVICE_CREDENTIAL";
function envServiceCredential(env = process.env) {
	return (env["WAF_SERVICE_CREDENTIAL"] ?? "").trim();
}
/**
* Short-lived cloud keys for a named service credential, or null if the workspace refused.
*
* Null on every failure: a 403, a 404, a network blip, a body this build does not
* recognise. The cloud collector treats null as unmeasurable, so inventing keys here
* would be the one way to turn a missing grant into a fabricated bill.
*/
async function vendServiceCredential(host, token, name, post = fetch) {
	if (name.trim() === "") return null;
	try {
		const response = await post(`${host}/api/2.1/unity-catalog/temporary-service-credentials`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({ credential_name: name })
		});
		if (!response.ok) return null;
		return cloudCredentialsFrom(await response.json());
	} catch {
		return null;
	}
}
function cloudCredentialsFrom(body) {
	if (body == null || typeof body !== "object") return null;
	const record = body;
	const expiresAt = expiresAtOf(record.expiration_time);
	const aws = record.aws_temp_credentials;
	if (aws != null && typeof aws === "object") {
		const keys = aws;
		const accessKeyId = text(keys.access_key_id);
		const secretAccessKey = text(keys.secret_access_key);
		const sessionToken = text(keys.session_token);
		if (accessKeyId != null && secretAccessKey != null && sessionToken != null) return {
			provider: "aws",
			expiresAt,
			aws: {
				accessKeyId,
				secretAccessKey,
				sessionToken
			}
		};
	}
	const azure = text(record.azure_aad_token);
	if (azure != null) return {
		provider: "azure",
		expiresAt,
		azure: { aadToken: azure }
	};
	const gcp = text(record.gcp_oauth_token);
	if (gcp != null) return {
		provider: "gcp",
		expiresAt,
		gcp: { oauthToken: gcp }
	};
	return null;
}
function expiresAtOf(value) {
	if (typeof value === "string" && value !== "") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	return /* @__PURE__ */ new Date();
}
function text(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Credentials taken from the request, whoever the proxy says they belong to.
*
* There is deliberately no fallback to the app's own identity. A scan that quietly
* ran as the service principal because a header was missing would report an estate
* the signed-in user cannot see, and the failure would look like success.
*
* The mode is read off the actor rather than fixed, so a scheduled run is stamped as the service
* principal it is. That is a statement about the identity and not about this door: everything here
* still comes through the forwarded token, which is the only door there is.
*/
function fromRequest(request, host, actor, actorName) {
	const token = headerValue(request, USER_TOKEN_HEADER);
	if (token == null || token === "") throw new MissingUserTokenError();
	const mode = modeFor(actor);
	return {
		mode,
		databricks() {
			return Promise.resolve({
				mode,
				actor,
				...actorName != null && actorName !== "" ? { actorName } : {},
				host,
				token: () => Promise.resolve(token)
			});
		},
		cloud(serviceCredentialName) {
			const name = (serviceCredentialName ?? envServiceCredential()).trim();
			if (name === "") return Promise.resolve(null);
			return vendServiceCredential(host, token, name);
		}
	};
}
//#endregion
export { MissingUserTokenError, SERVICE_CREDENTIAL_ENV, USER_IDENTITY_HEADERS, USER_TOKEN_HEADER, actorFromHeaders, envServiceCredential, fromRequest, modeFor, vendServiceCredential, workspaceHost };
