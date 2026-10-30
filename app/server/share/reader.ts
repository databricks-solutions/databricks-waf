// Whether the person reading is an assessor, which decides how much of a stored result they are shown.
//
// Decision D1 in docs/decisions.md. Published results, scores, outcomes and summaries are readable by
// every app user; statement text, principal identifiers in findings evidence and imported admin readings
// only by direct members of the assessor group. The rule here is the one `permitted()` applies to a
// change, asked on a read: the forwarded token, the groups SCIM lists for it, and the forwarded identity
// agreeing with the one SCIM verified.
//
// # Fail closed for detail, open for summaries
//
// A request with no token, a lookup that fails, a lookup that lists no groups and an identity that does
// not match all read as "not an assessor". The question is only ever asked in order to decide whether to
// show more, so every doubt resolves to showing less, and none of them stops the summary being served: a
// reader the check cannot place is a reader who still sees the score.
//
// # Once per request
//
// The answer is kept for the one request that asked and for nothing longer. A cache that outlived the
// request would carry a membership across a removal from the group, and the lookup is cheap enough that
// the reads which ask it twice pay for one call.

import { actorFromHeaders, USER_TOKEN_HEADER } from '../collect/credentials.js';
import { probeCurrentUser, type CurrentUser, type ScopeProbe } from '../collect/estate-scope.js';
import { requirePermission, requireVerifiedIdentity } from '../authorize/group.js';

/** Enough of a request to read its headers, which is all this needs and all a test has to supply. */
export interface ReadingRequest {
  readonly headers: NodeJS.Dict<string | string[]>;
}

/** Whether the request came from a direct member of the assessor group. */
export type AssessorCheck = (request: ReadingRequest) => Promise<boolean>;

export interface AssessorCheckOptions {
  readonly host: string;
  /** The group named by `WAF_ASSESSOR_GROUP`, the same one `permitted()` checks. */
  readonly assessorGroup: string;
  /** Replaceable so a test can answer without a workspace. */
  readonly probe?: (probe: ScopeProbe) => Promise<CurrentUser>;
}

export function assessorCheck(options: AssessorCheckOptions): AssessorCheck {
  const probe = options.probe ?? probeCurrentUser;
  const asked = new WeakMap<object, Promise<boolean>>();

  const decide = async (request: ReadingRequest): Promise<boolean> => {
    const raw = request.headers[USER_TOKEN_HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;
    // Nothing to ask the workspace with, so nothing to prove.
    if (token == null || token === '') return false;

    try {
      const user = await probe({ host: options.host, token });
      requireVerifiedIdentity(actorFromHeaders(request), user.userName);
      requirePermission(options.assessorGroup, {
        actor: user.userName ?? 'unknown',
        ...(user.groups != null ? { groups: user.groups } : {}),
      });
      return true;
    } catch {
      // A refusal from the gate and a lookup that threw are the same answer by two roads.
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
