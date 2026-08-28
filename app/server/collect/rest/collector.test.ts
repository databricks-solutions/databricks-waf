// What a refused probe tells the reader.
//
// The outcomes are the easy part and are barely tested here. What is tested is the
// sentence, because the sentence is the whole value of a control that could not be
// measured: three of these refusals have three different remedies, and a reader shown
// "permission denied" for all three has been told nothing.

import { describe, expect, it, vi } from 'vitest';
import { CollectionScheduler } from '../../scan/scheduler.js';
import type { CollectorContext, SignalId } from '../signal.js';
import type { CredentialProvider } from '../credentials.js';
import { RestCollector } from './collector.js';
import { REQUESTED_KEYS } from './settings-keys.js';

/**
 * A provider the collector never calls, because the client is injected.
 *
 * Built rather than cast, so a change to the interface is a compile error here instead of a fixture
 * that quietly stopped resembling the thing it stands in for.
 */
function unusedCredentials(): CredentialProvider {
  return {
    mode: 'on-behalf-of-user',
    databricks: () =>
      Promise.resolve({
        mode: 'on-behalf-of-user',
        actor: 'ada@example.com',
        host: 'https://example.cloud.databricks.com',
        token: () => Promise.resolve('t'),
      }),
    cloud: () => Promise.resolve(null),
  };
}

const SETTINGS = 'rest:workspace:preview.workspace-conf' as SignalId;
const TOKENS = 'rest:workspace:token.list' as SignalId;
const SERVING = 'rest:workspace:serving-endpoints' as SignalId;

/** An error shaped the way the SDK throws one, since the classifier reads the status. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function collectorRefusing(error: Error) {
  const client = {
    workspaceConf: { getStatus: vi.fn().mockRejectedValue(error) },
    tokenManagement: { list: vi.fn(() => rejectingIterable(error)) },
    servingEndpoints: { list: vi.fn(() => rejectingIterable(error)) },
  };
  return new RestCollector({ client: () => Promise.resolve(client as never) });
}

function rejectingIterable(error: Error): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<never> => Promise.reject(error),
    }),
  };
}

async function collect(collector: RestCollector, id: SignalId) {
  const results = await collector.collect([id], {
    scheduler: new CollectionScheduler(),
    collected: new Map(),
    lookbackDays: 30,
    scope: { narrowedTo: undefined },
  } as never);
  return results[0];
}

describe('a refused REST probe', () => {
  it('distinguishes a scope it can never have from one it could be granted', async () => {
    const scopeRefusal = httpError(403, 'Provided OAuth token does not have required scopes: settings');
    const settings = await collect(collectorRefusing(scopeRefusal), SETTINGS);

    expect(settings.status).toBe('unmeasurable');
    const reason = settings.unmeasurableReason ?? '';
    // The scope by the platform's own name, so a reader can search for it.
    expect(reason).toContain('"settings"');
    expect(reason).toContain('cannot be fixed from here');
    // And the reason the app does not simply read it as itself, which is the obvious
    // question a workspace admin asks next.
    expect(reason).toMatch(/estate you may not have the right to see/);

    const grantable = httpError(403, 'Provided OAuth token does not have required scopes: model-serving');
    const serving = await collect(collectorRefusing(grantable), SERVING);
    expect(serving.unmeasurableReason ?? '').toContain('has to declare it and be redeployed');
    expect(serving.unmeasurableReason ?? '').not.toContain('cannot be fixed from here');
  });

  it('does not blame the scopes when the user is simply not an admin', async () => {
    const denial = httpError(403, 'User is not an admin of this workspace');
    const tokens = await collect(collectorRefusing(denial), TOKENS);

    const reason = tokens.unmeasurableReason ?? '';
    expect(reason).toContain('may not read it');
    expect(reason).not.toContain('scope');
    // Says it is not evidence of a problem, because an unreadable control that scored as
    // a failure would reward installing the app with less access.
    expect(reason).toContain('not evidence of a problem');
  });

  it('reports a missing endpoint as absent rather than as misconfigured', async () => {
    const missing = httpError(404, 'Endpoint not found');
    const settings = await collect(collectorRefusing(missing), SETTINGS);

    expect(settings.status).toBe('unmeasurable');
    expect(settings.unmeasurableReason ?? '').toContain('cannot exist cannot be misconfigured');
  });

  it('is workspace reach, never account', async () => {
    // The system tables answer for the whole account from one install; these endpoints do
    // not, and a finding that implied otherwise would understate the estate by ten
    // workspaces on the account this was measured against. ADR 0015.
    const result = await collect(collectorRefusing(httpError(403, 'nope')), SETTINGS);
    expect(result.coverage?.reach).toBe('workspace');
  });
});

describe('a probe that answers', () => {
  it('keeps an unset setting distinct from one set to false', async () => {
    const client = {
      workspaceConf: {
        getStatus: vi.fn().mockResolvedValue({
          enableIpAccessLists: 'false',
          // Present in the response and null, which is the workspace saying "never set".
          enableVerboseAuditLogs: null,
        }),
      },
      tokenManagement: { list: vi.fn() },
      servingEndpoints: { list: vi.fn() },
    };
    const collector = new RestCollector({ client: () => Promise.resolve(client as never) });
    const result = await collect(collector, SETTINGS);

    expect(result.status).toBe('observed');
    const value = result.value as { values: Map<string, string | null>; unanswered: string[] };
    expect(value.values.get('enableIpAccessLists')).toBe('false');
    expect(value.values.get('enableVerboseAuditLogs')).toBeNull();
    // Everything else was asked for and not answered, which is a third state again: the
    // key does not exist on this workspace, rather than existing and being unset.
    expect(value.unanswered).toHaveLength(REQUESTED_KEYS.length - 2);
    expect(value.values.has('enableExportNotebook')).toBe(false);
  });

  it('does not read a token with no expiry as a token with missing data', async () => {
    const client = {
      workspaceConf: { getStatus: vi.fn() },
      tokenManagement: {
        list: vi.fn(() =>
          iterableOf([
            { token_id: 'a', created_by_username: 'ada@example.com', creation_time: 1_700_000_000_000 },
            { token_id: 'b', created_by_username: 'grace@example.com', creation_time: 1, expiry_time: 0 },
          ])
        ),
      },
      servingEndpoints: { list: vi.fn() },
    };
    const collector = new RestCollector({ client: () => Promise.resolve(client as never) });
    const result = await collect(collector, TOKENS);

    const value = result.value as { tokens: { expiresAt: Date | undefined }[] };
    // Both are perpetual tokens: one omits the field, the other sends zero for it. A zero
    // read literally would report a token that expired in 1970, which is not a finding
    // anyone can act on.
    expect(value.tokens.map((token) => token.expiresAt)).toEqual([undefined, undefined]);
  });
});

describe('an attempt carrying on a run that was interrupted', () => {
  function client() {
    return {
      workspaceConf: { getStatus: vi.fn().mockResolvedValue({}) },
      tokenManagement: { list: vi.fn(() => iterableOf([])) },
      servingEndpoints: { list: vi.fn(() => iterableOf([])) },
    };
  }

  /** A collection in which these signals have already been read by an earlier attempt. */
  function carrying(...ids: SignalId[]) {
    return new Map(
      ids.map((id) => [
        id,
        { id, status: 'observed' as const, coverage: { mode: 'complete' as const }, collectedAt: new Date(), durationMs: 1 },
      ])
    );
  }

  it('does not call the control plane again for a probe already on the record', async () => {
    // One probe is one control-plane call, and the token inventory pages through the whole list, so
    // re-reading what an earlier attempt already read is a real cost rather than a rounding one.
    const api = client();
    const collector = new RestCollector({ client: () => Promise.resolve(api as never) });
    const settled: SignalId[] = [];

    const context: CollectorContext = {
      credentials: unusedCredentials(),
      scheduler: new CollectionScheduler(),
      collected: carrying(TOKENS),
      settled: (reading) => {
        settled.push(reading.id);
        return Promise.resolve();
      },
    };
    const results = await collector.collect([TOKENS, SETTINGS], context);

    expect(api.tokenManagement.list).not.toHaveBeenCalled();
    expect(api.workspaceConf.getStatus).toHaveBeenCalled();
    // And what it did read is both returned and reported, so the record gains it before the next probe
    // starts rather than at the end of the collector.
    expect(results.map((result) => result.id)).toEqual([SETTINGS]);
    expect(settled).toEqual([SETTINGS]);
  });
});

function iterableOf<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<T>> =>
          Promise.resolve(index < items.length ? { value: items[index++], done: false } : { value: undefined, done: true }),
      };
    },
  };
}
