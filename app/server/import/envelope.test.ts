// The envelope schema, tested mostly by what it refuses.
//
// The positive case is one test, because there is one shape and a real example of it is already
// asserted against in `trust.test.ts` and `canonical-agreement.test.ts`. Everything else here is a
// document that is valid JSON and not a valid envelope, which is the population this layer exists for:
// by the time a file reaches it, it has already been proved parseable, so anything left is either
// somebody's older script, somebody's hand edit, or somebody's attempt.
//
// Each refusal asserts the reason code and the field path rather than the message, so the sentences
// can be rewritten without the suite needing to change and a reason code cannot be silently widened.

import { describe, expect, it } from 'vitest';
import { envelopeFrom, MalformedEnvelopeError, MAX_PROBES, MAX_STRING } from './envelope.js';
import { envelope, identity, probe } from './envelope-fixture.js';

/** The reason and field path of the refusal, or a failure that names what came back instead. */
function refusalFrom(value: unknown): { reason: string; at?: string } {
  try {
    envelopeFrom(value);
  } catch (error) {
    if (error instanceof MalformedEnvelopeError) return { reason: error.reason, at: error.at };
    throw error;
  }
  throw new Error('the envelope was accepted, and the test expected it to be refused');
}

describe('an envelope this app can read', () => {
  it('is accepted, and its fields arrive in the app\u2019s own spelling', () => {
    const read = envelopeFrom(envelope());

    expect(read.generatedAt).toBe('2026-08-03T10:41:52Z');
    expect(read.tiers.workspace.identity?.workspaceId).toBe('7000000000000001');
    expect(read.tiers.account.ran).toBe(false);
    expect(read.probes[0].signals).toStrictEqual(['rest:workspace:preview.workspace-conf']);
    expect(read.probes[0].value).toStrictEqual({ enableIpAccessLists: 'true' });
    expect(read.deferred[0].signal).toBe('rest:workspace:permissions.jobs.{job_id}');
  });

  it('carries no value on a probe that observed nothing, rather than an undefined one', () => {
    const read = envelopeFrom(
      envelope({ probes: [probe({ status: 'denied', value: undefined, detail: 'Access is denied on path' })] })
    );

    // `in` rather than a null check: the difference between absent and undefined is what the digest
    // is computed over, and a key present with undefined would canonicalise differently.
    expect('value' in read.probes[0]).toBe(false);
    expect(read.probes[0].detail).toBe('Access is denied on path');
  });
});

describe('a document that is not this envelope', () => {
  it('is refused when it is not an object at all', () => {
    expect(refusalFrom([]).reason).toBe('bad-field');
    expect(refusalFrom('a string').reason).toBe('bad-field');
    expect(refusalFrom(null).reason).toBe('bad-field');
  });

  it('names the schema it read when the version is one this app does not know', () => {
    expect(refusalFrom(envelope({ schema: 'waf-admin-evidence/2' }))).toStrictEqual({
      reason: 'unknown-schema',
      at: 'schema',
    });
  });

  it('is refused rather than emptied when it carries no probes', () => {
    expect(refusalFrom(envelope({ probes: [] }))).toStrictEqual({ reason: 'inconsistent', at: 'probes' });
  });
});

describe('a field that is absent, wrong or unbounded', () => {
  it('is refused rather than defaulted, for each field the app makes a claim on', () => {
    // One assertion per field, listed rather than looped, so a field removed from this table is a
    // visible deletion in review instead of a silently shorter loop.
    expect(refusalFrom(envelope({ generated_at: undefined })).at).toBe('generated_at');
    expect(refusalFrom(envelope({ digest: undefined })).at).toBe('digest');
    expect(refusalFrom(envelope({ cli: {} })).at).toBe('cli.version');
    expect(refusalFrom(envelope({ script: { name: 'x', version: '1' } })).at).toBe('script.digest');
    expect(refusalFrom(envelope({ tiers: { workspace: {}, account: { ran: false } } })).at).toBe('tiers.workspace.ran');
    expect(refusalFrom(envelope({ probes: [probe({ status: undefined })] })).at).toBe('probes[0].status');
    expect(refusalFrom(envelope({ probes: [probe({ tier: undefined })] })).at).toBe('probes[0].tier');
    expect(refusalFrom(envelope({ probes: [probe({ label: '' })] })).at).toBe('probes[0].label');
  });

  it('is refused when a scalar arrives where a collection belongs, and the reverse', () => {
    expect(refusalFrom(envelope({ probes: probe() })).at).toBe('probes');
    expect(refusalFrom(envelope({ tiers: [] })).at).toBe('tiers');
    expect(refusalFrom(envelope({ probes: [probe({ controls: 'SCP-01-04' })] })).at).toBe('probes[0].controls');
    expect(refusalFrom(envelope({ probes: [probe({ signals: [42] })] })).at).toBe('probes[0].signals[0]');
  });

  it('is refused for a value outside its enumeration, not coerced to the nearest one', () => {
    expect(refusalFrom(envelope({ probes: [probe({ status: 'OBSERVED' })] })).at).toBe('probes[0].status');
    expect(refusalFrom(envelope({ probes: [probe({ status: 'partial' })] })).at).toBe('probes[0].status');
    expect(refusalFrom(envelope({ probes: [probe({ tier: 'metastore' })] })).at).toBe('probes[0].tier');
    expect(refusalFrom(envelope({ probes: [probe({ shape: 'raw' })] })).at).toBe('probes[0].shape');
  });

  it('is refused when a string is long enough to be a payload', () => {
    expect(refusalFrom(envelope({ probes: [probe({ label: 'x'.repeat(MAX_STRING + 1) })] })).at).toBe('probes[0].label');
  });

  it('is refused when a collection is long enough to be a denial of service', () => {
    const many = Array.from({ length: MAX_PROBES + 1 }, () => probe());
    expect(refusalFrom(envelope({ probes: many }))).toStrictEqual({ reason: 'bad-field', at: 'probes' });
  });

  it('accepts a truncated flag only as a boolean, since a string "false" is true', () => {
    expect(refusalFrom(envelope({ probes: [probe({ truncated: 'false' })] })).at).toBe('probes[0].truncated');
    expect(envelopeFrom(envelope({ probes: [probe({ truncated: true })] })).probes[0].truncated).toBe(true);
  });
});

describe('a timestamp', () => {
  it('is refused unless it is the form the script writes', () => {
    // Each of these is something `new Date()` accepts and turns into a real instant, which is how a
    // freshness window comes to measure from the wrong year.
    for (const bad of ['2026', '2026-08-03', '2026-08-03T10:41:52+10:00', '2026-08-03 10:41:52Z', 'now']) {
      expect(refusalFrom(envelope({ generated_at: bad }))).toStrictEqual({ reason: 'bad-field', at: 'generated_at' });
    }
  });

  it('is refused when it has the right shape and is not a real instant', () => {
    expect(refusalFrom(envelope({ generated_at: '2026-02-30T10:41:52Z' })).at).toBe('generated_at');
  });
});

describe('a digest', () => {
  it('is refused unless it names its algorithm and is the full length', () => {
    for (const bad of ['a'.repeat(64), `sha256:${'a'.repeat(63)}`, `sha256:${'A'.repeat(64)}`, 'sha512:' + 'a'.repeat(64), 'sha256:']) {
      expect(refusalFrom(envelope({ digest: bad })).at).toBe('digest');
    }
  });
});

describe('an envelope that is well-formed and contradicts itself', () => {
  it('is refused when a probe observed something and carries nothing', () => {
    expect(refusalFrom(envelope({ probes: [probe({ value: undefined })] }))).toStrictEqual({
      reason: 'inconsistent',
      at: 'probes[0]',
    });
  });

  it('is refused when a probe that was refused carries a reading anyway', () => {
    expect(refusalFrom(envelope({ probes: [probe({ status: 'skipped' })] }))).toStrictEqual({
      reason: 'inconsistent',
      at: 'probes[0]',
    });
  });

  it('is refused when a tier ran and says nothing about who ran it', () => {
    // Without an identity there is nothing to hold the file against, so the target check would pass
    // by having nothing to compare. Refused here so that cannot happen quietly.
    expect(refusalFrom(envelope({ tiers: { workspace: { ran: true }, account: { ran: false } } }))).toStrictEqual({
      reason: 'inconsistent',
      at: 'tiers.workspace',
    });
  });

  it('is refused when a tier did not run and carries an identity', () => {
    expect(
      refusalFrom(envelope({ tiers: { workspace: { ran: false, identity: identity() }, account: { ran: false } } })).at
    ).toBe('tiers.workspace');
  });

  it('accepts a tier that ran without a username, because an account profile has none', () => {
    const read = envelopeFrom(
      envelope({
        tiers: {
          workspace: { ran: true, identity: identity() },
          account: { ran: true, identity: identity({ username: null, workspace_id: null, read: 'text' }) },
        },
      })
    );

    expect(read.tiers.account.identity?.username).toBeUndefined();
    expect(read.tiers.account.identity?.accountId).toBe('00000000-1111-2222-3333-444444444444');
  });
});
