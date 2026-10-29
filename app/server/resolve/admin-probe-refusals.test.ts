// What a reader sees for a control whose only evidence is a call no app can make.
//
// Sixteen security controls read endpoints that need an administrator's scope or the account
// plane. Without an import they have nothing, and the right answer is the same one the controls
// behind the live refused probes already give: unreachable, to be answered by a person. This drives
// the real collector into the real resolver through the real registry, because the fault it guards
// was invisible one layer at a time — each piece passed its own test while the pair, assembled the
// way a scan assembles them, filed a platform limit under "a defect in this app".

import { describe, expect, it, vi } from 'vitest';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { RestCollector } from '../collect/rest/collector.js';
import { PROBES } from '../collect/rest/probes.js';
import { unmeasurable, type SignalId, type SignalResult } from '../collect/signal.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import { remedyFor } from './remedy.js';
import { resolveControl } from './resolver.js';
import { buildRegistry } from './resolvers/index.js';

const CATALOGUE = loadCatalogue();
const REGISTRY = buildRegistry();

/** Controls whose evidence is a probe that never reaches the SDK. */
const STUB_BACKED = [
  'SCP-01-06', 'SCP-02-01', 'SCP-02-02', 'SCP-02-10', 'SCP-02-11',
  'SCP-03-05', 'SCP-03-08', 'SCP-03-12',
  'SCP-04-02', 'SCP-04-03', 'SCP-04-19', 'SCP-04-20', 'SCP-04-21',
  'SCP-05-11', 'SCP-05-13', 'SCP-05-14',
] as const;

/** Controls behind the two probes that do call the control plane, and are refused there. */
const LIVE_UNGRANTABLE = [
  'SCP-01-03', 'SCP-01-04', 'SCP-01-05',
  'SCP-02-04', 'SCP-02-05', 'SCP-02-06', 'SCP-02-07', 'SCP-02-08', 'SCP-02-12',
  'SCP-03-10',
  'SCP-04-01', 'SCP-04-08', 'SCP-04-09',
  'SCP-05-04', 'SCP-05-05', 'SCP-05-06', 'SCP-05-07', 'SCP-05-15',
] as const;

/** An error shaped the way the SDK throws one, since the classifier reads the status. */
function refused(message: string): Error {
  return Object.assign(new Error(message), { status: 403 });
}

/** Every probe, collected the way a scan collects it, with the two live calls refused by the platform. */
async function collectedWithoutAnImport(): Promise<ReadonlyMap<SignalId, SignalResult>> {
  const refusing = (scope: string) => () => Promise.reject(refused(`Provided OAuth token does not have required scopes: ${scope}`));
  const client = {
    workspaceConf: { getStatus: vi.fn(refusing('settings')) },
    tokenManagement: {
      list: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({ next: refusing('authentication') }),
      })),
    },
    servingEndpoints: { list: vi.fn() },
  };
  const collector = new RestCollector({ client: () => Promise.resolve(client as never) });
  const results = await collector.collect(
    PROBES.map((probe) => probe.id),
    { scheduler: new CollectionScheduler(), collected: new Map(), lookbackDays: 30, scope: { narrowedTo: undefined } } as never
  );
  return new Map(results.map((result) => [result.id, result]));
}

function resolve(controlId: string, signals: ReadonlyMap<SignalId, SignalResult>) {
  const spec = CATALOGUE.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  return resolveControl(spec, signals, REGISTRY.get(controlId));
}

describe('a control whose only evidence is an admin-only probe, with no import held', () => {
  it.each(STUB_BACKED)('reads %s as unreachable, to be answered by a person', async (controlId) => {
    const finding = resolve(controlId, await collectedWithoutAnImport());

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('unreachable');
    expect(finding.remedy?.kind).toBe('attest');
  });

  it.each(LIVE_UNGRANTABLE)('still reads %s, behind a refused live probe, as unreachable', async (controlId) => {
    const finding = resolve(controlId, await collectedWithoutAnImport());

    expect(finding.unmeasured).toBe('unreachable');
    expect(finding.remedy?.kind).toBe('attest');
  });

  it('keeps a SQL permission denial as something the reader can grant', () => {
    const signals = new Map<SignalId, SignalResult>([
      ['sql:uc.census', unmeasurable('sql:uc.census', 'PERMISSION_DENIED: User does not have USE CATALOG on Catalog main.')],
    ]);
    const finding = resolve('CO-01-01', signals);

    expect(finding.unmeasured).toBe('unreadable');
    expect(finding.remedy?.kind).toBe('grant');
  });
});

describe('the signal an admin-only probe leaves', () => {
  it('names the scope as the platform does and says what refused it, in machine-readable form', async () => {
    const signals = await collectedWithoutAnImport();

    const clusters = signals.get('rest:workspace:clusters.list');
    expect(clusters?.refusal).toEqual({ kind: 'ungrantable-scope', scope: 'clusters' });
    expect(clusters?.unmeasurableReason).toContain('required scopes: clusters');

    const account = signals.get('rest:account:accounts.log-delivery');
    expect(account?.refusal).toEqual({ kind: 'account-plane' });
  });

  it('is made without calling the control plane', async () => {
    const client = vi.fn(() => Promise.reject(new Error('the control plane should not be asked')));
    const collector = new RestCollector({ client });
    const scheduler = new CollectionScheduler();

    await collector.collect(
      ['rest:workspace:clusters.list', 'rest:account:accounts.log-delivery'],
      { scheduler, collected: new Map(), lookbackDays: 30, scope: { narrowedTo: undefined } } as never
    );

    expect(client).not.toHaveBeenCalled();
    expect(collector.spent().calls).toBe(0);
  });
});

describe('reading the refusal before the words', () => {
  const ID = 'rest:workspace:clusters.list' as SignalId;

  it('decides from the structured refusal when the reason names nothing recognisable', () => {
    const signal: SignalResult = {
      ...unmeasurable(ID, 'Something went wrong in words this app has never seen.'),
      refusal: { kind: 'ungrantable-scope', scope: 'clusters' },
    };

    expect(remedyFor([ID], new Map([[ID, signal]]))?.kind).toBe('attest');
  });

  it('prefers the refusal to a reason that points the other way', () => {
    // A reason mentioning a transient failure would send the reader to retry. The refusal is a fact
    // about the call; the reason is prose about it.
    const signal: SignalResult = {
      ...unmeasurable(ID, 'The request timed out.'),
      refusal: { kind: 'account-plane' },
    };

    expect(remedyFor([ID], new Map([[ID, signal]]))?.kind).toBe('attest');
  });

  it('falls back to the words for a signal stored before the field existed', () => {
    const signal = unmeasurable(ID, 'Provided OAuth token does not have required scopes: clusters');

    expect(signal.refusal).toBeUndefined();
    // The collector comes from the catalogue, as the resolver supplies it for a real finding.
    expect(remedyFor([ID], new Map([[ID, signal]]), { collector: ID })?.kind).toBe('attest');
  });
});
