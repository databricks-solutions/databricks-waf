import { requirePermission, requireVerifiedIdentity } from "../authorize/group.js";
import { USER_TOKEN_HEADER, actorFromHeaders } from "../collect/credentials.js";
import { probeCurrentUser } from "../collect/estate-scope.js";
//#region server/share/reader.ts
function assessorCheck(options) {
	const probe = options.probe ?? probeCurrentUser;
	const asked = /* @__PURE__ */ new WeakMap();
	const decide = async (request) => {
		const raw = request.headers[USER_TOKEN_HEADER];
		const token = Array.isArray(raw) ? raw[0] : raw;
		if (token == null || token === "") return false;
		try {
			const user = await probe({
				host: options.host,
				token
			});
			requireVerifiedIdentity(actorFromHeaders(request), user.userName);
			requirePermission(options.assessorGroup, {
				actor: user.userName ?? "unknown",
				...user.groups != null ? { groups: user.groups } : {}
			});
			return true;
		} catch {
			return false;
		}
	};
	return (request) => {
		const held = asked.get(request);
		if (held != null) return held;
		const answer = decide(request);
		asked.set(request, answer);
		return answer;
	};
}
//#endregion
export { assessorCheck };
