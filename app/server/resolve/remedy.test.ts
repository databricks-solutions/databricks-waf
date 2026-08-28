// The cases these tests exist for are the two that are expensive to get wrong.
//
// A permanent limit reported as stale consent sends someone round a re-authorisation loop that
// cannot terminate; an ungrantable scope reported as a grant sends a workspace admin to issue a
// permission that does not exist. Both end with the reader deciding the app's advice is noise,
// which costs more than the unmeasured requirement did. So the assertions here are mostly about
// which of two indistinguishable 403s a message is.

import { describe, expect, it } from 'vitest';
import { remedyFor } from './remedy.js';
import type { SignalId, SignalResult } from '../collect/signal.js';

function result(id: SignalId, over: Partial<SignalResult>): SignalResult {
  return { id, status: 'observed', coverage: { mode: 'complete' }, collectedAt: new Date(), durationMs: 1, ...over };
}

function refused(reason: string, id: SignalId = ID): SignalResult {
  return result(id, { status: 'unmeasurable', unmeasurableReason: reason });
}

function answered(id: SignalId = ID): SignalResult {
  return result(id, { value: {} });
}

function signals(entries: Record<string, SignalResult>): ReadonlyMap<SignalId, SignalResult> {
  return new Map(Object.entries(entries) as [SignalId, SignalResult][]);
}

const ID = 'rest:clusters.list' as SignalId;

describe('remedyFor', () => {
  it('says nothing when every signal answered, because a resolver may return unmeasurable from good data', () => {
    expect(remedyFor([ID], signals({ [ID]: answered() }))).toBeUndefined();
  });

  it('treats a signal missing from the map as failed, since a resolver that never ran is a gap too', () => {
    expect(remedyFor([ID], signals({}))?.kind).toBe('report');
  });

  it('names the signals it read, so the reader can find the query behind the advice', () => {
    const other = 'rest:jobs.list' as SignalId;
    const remedy = remedyFor([ID, other], signals({ [ID]: refused('403 permission denied'), [other]: answered() }));

    expect(remedy?.signals).toEqual([ID]);
  });

  it('quotes the platform verbatim, so the sentence above it can be checked rather than trusted', () => {
    const remedy = remedyFor([ID], signals({ [ID]: refused('PERMISSION_DENIED: no SELECT on system.access') }));

    expect(remedy?.because).toBe('PERMISSION_DENIED: no SELECT on system.access');
  });

  describe('a refusal naming a scope', () => {
    it('is a re-authorisation when the app asked for the scope and this token lacks it', () => {
      const remedy = remedyFor([ID], signals({ [ID]: refused('invalid scope, required scopes: dashboards') }), {
        declaredScopes: ['dashboards', 'sql'],
      });

      expect(remedy?.kind).toBe('re-authorise');
      expect(remedy?.says).toContain('consent predates');
    });

    it('is an answer from a person when the scope is one no install may hold', () => {
      const remedy = remedyFor([ID], signals({ [ID]: refused('invalid scope, required scopes: clusters') }), {
        // Declared and ungrantable at once is the case that must not read as re-authorise: the
        // manifest asking for it does not make the platform mint it.
        declaredScopes: ['clusters'],
        collector: 'rest:workspace:clusters.list',
      });

      expect(remedy?.kind).toBe('attest');
    });

    it('explains an account-plane refusal by the plane rather than by the scope, since no scope helps', () => {
      const remedy = remedyFor([ID], signals({ [ID]: refused('invalid scope, required scopes: account') }), {
        collector: 'rest:account:accounts.workspaces.list',
      });

      expect(remedy?.kind).toBe('attest');
      expect(remedy?.says).toContain('account-plane');
    });

    it('is our omission when the app never declared the scope and no family says it is unreachable', () => {
      const remedy = remedyFor([ID], signals({ [ID]: refused('invalid scope, required scopes: iam') }), {
        declaredScopes: ['sql'],
      });

      expect(remedy?.kind).toBe('report');
      expect(remedy?.says).toContain('app manifest');
    });
  });

  describe('a refusal naming no scope', () => {
    it('is a grant when the identity was refused, because that one is inside the reader’s own estate', () => {
      expect(remedyFor([ID], signals({ [ID]: refused('PERMISSION_DENIED on system.billing') }))?.kind).toBe('grant');
    });

    it('is an enablement when the source is absent, which is per-schema rather than a misconfiguration', () => {
      expect(remedyFor([ID], signals({ [ID]: refused('TABLE_OR_VIEW_NOT_FOUND: system.lakeflow.jobs') }))?.kind).toBe(
        'enable'
      );
    });

    it('is a retry when the run ran out of budget, so nothing about the estate is implied', () => {
      const remedy = remedyFor([ID], signals({ [ID]: refused('cancelled: surface budget reached') }));

      expect(remedy?.kind).toBe('retry');
      expect(remedy?.says).toContain('Nothing about your estate');
    });

    it('is ours when the refusal is unreadable, rather than guessing at one of the others', () => {
      expect(remedyFor([ID], signals({ [ID]: refused('MALFORMED_REQUEST: unexpected token') }))?.kind).toBe('report');
    });

    it('is ours when a signal failed and reported no reason at all', () => {
      const remedy = remedyFor([ID], signals({ [ID]: result(ID, { status: 'unmeasurable' }) }));

      expect(remedy?.kind).toBe('report');
      expect(remedy?.says).toContain('defect in this app');
    });

    it('reads a permission refusal as a grant even though it also says the table was not found', () => {
      // The phrases overlap, and the order they are tested in is the whole behaviour: absence is
      // checked before permission, because a refused read of a system table often reports both
      // and the narrower advice is to enable the schema.
      const remedy = remedyFor([ID], signals({ [ID]: refused('permission denied: relation does not exist') }));

      expect(remedy?.kind).toBe('enable');
    });
  });

  describe('several signals failing differently', () => {
    it('reports the least actionable, so nobody issues a grant that would not make it measurable', () => {
      const grant = 'sql:uc.census' as SignalId;
      const ungrantable = 'rest:clusters.list' as SignalId;

      const remedy = remedyFor([grant, ungrantable], signals({
        [grant]: refused('PERMISSION_DENIED on system.information_schema'),
        [ungrantable]: refused('invalid scope, required scopes: clusters'),
      }), { collector: 'rest:workspace:clusters.list' });

      expect(remedy?.kind).toBe('attest');
    });

    it('still lists every failed signal, not only the one the advice came from', () => {
      const a = 'sql:uc.census' as SignalId;
      const b = 'rest:clusters.list' as SignalId;

      const remedy = remedyFor([a, b], signals({
        [a]: refused('PERMISSION_DENIED'),
        [b]: refused('invalid scope, required scopes: clusters'),
      }), { collector: 'rest:workspace:clusters.list' });

      expect(remedy?.signals).toEqual([a, b]);
    });

    it('prefers a grant over a retry, because the transient one resolves itself and the grant does not', () => {
      const a = 'sql:uc.census' as SignalId;
      const b = 'rest:jobs.list' as SignalId;

      const remedy = remedyFor([a, b], signals({
        [a]: refused('timed out after 30s'),
        [b]: refused('PERMISSION_DENIED'),
      }));

      expect(remedy?.kind).toBe('grant');
    });
  });
});
