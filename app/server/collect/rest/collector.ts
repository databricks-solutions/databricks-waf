// The REST collector.
//
// Where the SQL collector asks the warehouse about the estate's history, this asks the
// control plane about its configuration: what a workspace's settings are, what tokens
// exist, what endpoints are serving. That is the only place most of the security pillar
// lives — a token policy is not in any system table, so no query can find it.
//
// Two things about it differ from the SQL collector and both are deliberate.
//
// It runs as whoever the scan runs as, which under on-behalf-of is the signed-in user.
// See `client.ts` for why the app's own service principal is not an option.
//
// And a refusal is a normal result. Most of these endpoints are workspace-admin only,
// and the app's user-authorization scopes are narrower still, so a probe being turned
// away is the common case rather than the exception. The two causes need different
// sentences: an app that never asked for the scope is fixed by redeploying the app,
// while a user who may not read the setting is fixed by granting the user — or by
// accepting that this reader cannot see it. Collapsing both into "permission denied"
// leaves the reader with no idea which of those to do.

import type { Reach } from '../signal.js';
import type { Surface } from '../../scan/surfaces.js';
import type { Collector, CollectorContext, CollectorSpend, SignalId, SignalResult } from '../signal.js';
import { COMPLETE, observed, unmeasurable } from '../signal.js';
import type { WorkspaceClientFactory } from './client.js';
import { PROBES, type Probe } from './probes.js';

export const REST_SIGNALS: readonly SignalId[] = PROBES.map((probe) => probe.id);

export interface RestCollectorOptions {
  readonly client: WorkspaceClientFactory;
  /**
   * Ceiling on records drained from a paginated listing.
   *
   * Separate from the scheduler's budget because they bound different things: the
   * scheduler counts probes, and one probe over a workspace with ten thousand tokens is
   * one probe with a lot of pages behind it. The results say when they hit this, so a
   * count from a truncated listing is never reported as a total.
   */
  readonly pageLimit?: number;
}

export class RestCollector implements Collector {
  readonly surface: Surface = 'rest';
  readonly name = 'control-plane';
  readonly signals: readonly SignalId[] = REST_SIGNALS;

  private readonly pageLimit: number;
  private calls = 0;

  constructor(private readonly options: RestCollectorOptions) {
    this.pageLimit = options.pageLimit ?? 1000;
  }

  spent(): CollectorSpend {
    return { surface: this.surface, name: this.name, calls: this.calls };
  }

  async collect(ids: readonly SignalId[], context: CollectorContext): Promise<SignalResult[]> {
    const results: SignalResult[] = [];
    for (const id of ids) {
      // Already read, by an earlier attempt at this run. One probe is one control-plane call and the
      // token inventory pages through a workspace's whole token list, so re-reading what is already on
      // the record is a real cost rather than a rounding one. Nothing here carries state between
      // probes, so skipping one changes nothing for the rest — including the spend, which counts calls
      // made and this one is not made.
      if (context.collected.has(id)) continue;

      const probe = PROBES.find((candidate) => candidate.id === id);
      // Unreachable through the scan, which only asks for signals this collector
      // declares. Answered rather than thrown so a future signal added to the catalogue
      // and not here degrades one control instead of failing the scan.
      const result = probe == null ? unmeasurable(id, `No REST probe is implemented for ${id}.`) : await this.runProbe(probe, context);
      results.push(result);

      // Reported as it settles, so an interrupted run keeps it rather than losing every probe this
      // collector had already made. Awaited: a reading reported and not yet written is one a kill still
      // loses, which is the case the whole mechanism exists for.
      await context.settled?.(result);
    }
    return results;
  }

  private async runProbe(probe: Probe, context: CollectorContext): Promise<SignalResult> {
    const started = Date.now();
    const outcome = await context.scheduler.run({
      surface: 'rest',
      label: `rest:${probe.label}`,
      run: async () => {
        const client = await this.options.client();
        this.calls += 1;
        return probe.run(client, { pageLimit: this.pageLimit });
      },
    });

    if (outcome.status === 'ok') {
      return observed(probe.id, outcome.value, Date.now() - started, { ...COMPLETE, reach: REST_REACH });
    }

    if (outcome.status === 'skipped') {
      return unmeasurable(probe.id, skipReason(probe, outcome.reason, outcome.detail), { ...COMPLETE, reach: REST_REACH });
    }

    return unmeasurable(probe.id, failureReason(probe, outcome.failure.kind, outcome.failure.message), {
      ...COMPLETE,
      reach: REST_REACH,
    });
  }
}

/**
 * Every REST probe is workspace-reach, and this is not a simplification.
 *
 * Measured under ADR 0015: a workspace token is rejected by another workspace's control
 * plane outright, so unlike the system tables — which answer for the whole account from
 * one install — these endpoints describe the workspace the app is installed in and
 * nothing else. An account with eleven workspaces needs eleven installs to have these
 * eleven answers.
 */
const REST_REACH: Reach = 'workspace';

function skipReason(probe: Probe, reason: string, detail: string): string {
  if (reason === 'permission-denied' || reason === 'not-found') return failureReason(probe, reason, detail);
  if (reason === 'budget-exhausted') {
    return `${probe.what} was not read because the scan reached its limit on control-plane calls. ${detail}`;
  }
  return `${probe.what} was not read: ${detail}`;
}

/**
 * The reason a probe did not answer, in terms of what the reader can do about it.
 *
 * The scope case is separated because it is the one the reader cannot act on from inside
 * the workspace: no amount of granting the user admin will help if the app never
 * requested authority over that API. Naming the scope turns it from a dead end into a
 * line in an issue report.
 */
function failureReason(probe: Probe, kind: string, message: string): string {
  if (kind === 'not-found') {
    return (
      `${probe.what} is not available in this workspace. The endpoint answered that it does not exist, which ` +
      `usually means the feature is not offered on this cloud or tier. Reported as unmeasured rather than as a ` +
      `failure, since a setting that cannot exist cannot be misconfigured. (${message})`
    );
  }

  if (kind === 'permission-denied') {
    if (looksLikeScope(message)) {
      const preamble =
        `${probe.what} was refused for want of an authorization scope, not for want of permission. This call ` +
        `needs the "${probe.scope}" scope, and the token the app is given does not carry it. Granting the ` +
        `identity this scan ran as more permission will not change that.`;

      return probe.grantable
        ? `${preamble} The scope can be requested, so this is fixable: the app has to declare it and be ` +
            `redeployed, and each user re-authorises the app the first time the wider set is asked for. ` +
            `(${message})`
        : `${preamble} And it cannot be fixed from here: Databricks Apps does not offer "${probe.scope}" as a ` +
            `scope an app may request, so no install of this app can read it as the calling identity. Reading it ` +
            `as the app's own identity instead would show you an estate you may not have the right to see, ` +
            `which is why the app does not. Until the platform offers the scope, this control is answered by ` +
            `attestation rather than by measurement. (${message})`;
    }

    return (
      `${probe.what} was refused: the identity this scan ran as may not read it. Most control-plane settings are ` +
      `workspace-admin only. This is reported as unmeasured rather than as a failure, because not being ` +
      `allowed to look is not evidence of a problem. (${message})`
    );
  }

  return `${probe.what} could not be read: ${message}`;
}

/**
 * Whether a refusal was about scopes rather than about the user.
 *
 * Text matching, which is fragile, and the fragility is bounded on purpose: a wrong
 * guess here changes only which of two sentences a reader sees, never whether the
 * control degrades. Both paths already report unmeasurable.
 */
function looksLikeScope(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('scope') || lower.includes('not authorized to access this api') || lower.includes('insufficient_scope');
}
