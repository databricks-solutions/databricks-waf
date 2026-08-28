// Whether an envelope may be believed, tested against the ways it should not be.
//
// The suite is organised by what a refusal protects, because that is what a reader needs to check is
// still protected: an edited reading, a file from another estate, a file from last quarter, a file
// already imported. The positive cases are here too and they are the smaller half — a verdict that
// trusts everything and a verdict that trusts nothing are equally useless, and only the negative half
// tells them apart.
//
// One test in here runs against the real collected envelope rather than a built one, and it is the
// most valuable test in the file: it asserts that a digest computed by Python over 29 real probes is
// the digest this module computes in TypeScript. Every other check in this module reads a field that
// this property is what makes trustworthy.

import { describe, expect, it } from 'vitest';
import { COLLECTED } from '../evidence/collected-fixture.js';
import { envelopeFrom, type Envelope } from './envelope.js';
import { envelope } from './envelope-fixture.js';
import { assess, digestOf, MAX_AGE_DAYS, MAX_SKEW_MINUTES, STALE_AFTER_DAYS, type CautionReason, type RefusalReason } from './trust.js';

const NOW = new Date('2026-08-03T12:00:00Z');

/** An envelope whose recorded digest matches its probes, which is the normal case. */
function sealed(overrides: Record<string, unknown> = {}): Envelope {
  const raw = envelope(overrides);
  return envelopeFrom({ ...raw, digest: digestOf(raw.probes) });
}

function refusals(verdict: { refusals: readonly { reason: RefusalReason }[] }): readonly RefusalReason[] {
  return verdict.refusals.map((note) => note.reason);
}

function cautions(verdict: { cautions: readonly { reason: CautionReason }[] }): readonly CautionReason[] {
  return verdict.cautions.map((note) => note.reason);
}

/** Days before `NOW`, in the form the script writes. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString().replace('.000Z', 'Z');
}

describe('an envelope collected here, today', () => {
  it('is trusted, and says nothing it does not need to', () => {
    const verdict = assess({
      envelope: sealed({ generated_at: daysAgo(1) }),
      target: { accountId: '00000000-1111-2222-3333-444444444444', workspaceIds: ['7000000000000001'] },
      now: NOW,
    });

    expect(verdict.trusted).toBe(true);
    expect(refusals(verdict)).toStrictEqual([]);
    // The account tier not having run is worth saying; nothing else about this file is.
    expect(cautions(verdict)).toStrictEqual(['tier-not-run']);
    expect(verdict.ageHours).toBe(24);
  });
});

describe('the digest, which is what makes every other field worth reading', () => {
  it('agrees with the digest Python computed over the same real probes', () => {
    // The cross-language property, on 29 probes nobody chose, pinned as a literal. The value was
    // produced by running the shipped script's own `digest()` over this fixture and this module's
    // `digestOf` over the same fixture, and comparing. A golden literal rather than two live
    // computations because the failure this guards against is both implementations moving together:
    // a change to the shared canonicalisation rules would keep them agreeing with each other while
    // making every envelope already collected in the field unimportable.
    expect(digestOf(COLLECTED)).toBe('sha256:bccc42fc72263abb4a2f24654201695e1cec9bb978dfb4ae3f0b71c02bca326d');
    // Determinism over the same value, which is what a key-ordering bug breaks.
    expect(digestOf(COLLECTED)).toBe(digestOf(structuredClone(COLLECTED)));
  });

  it('refuses a file whose reading was changed after collection', () => {
    const original = sealed();
    const edited: Envelope = {
      ...original,
      probes: [{ ...original.probes[0], value: { enableIpAccessLists: 'false' } }],
    };

    const verdict = assess({ envelope: edited, now: NOW });
    expect(refusals(verdict)).toContain('digest-mismatch');
    expect(verdict.trusted).toBe(false);
  });

  it('refuses a file whose digest was changed to match an edited reading', () => {
    // The obvious next move for anyone editing a file, and the reason the digest is recomputed here
    // rather than compared between two fields of the same document.
    const original = sealed();
    const forged: Envelope = {
      ...original,
      probes: [{ ...original.probes[0], value: { enableIpAccessLists: 'false' } }],
      digest: digestOf([{ ...original.probes[0], value: { enableIpAccessLists: 'true' } }]),
    };

    expect(refusals(assess({ envelope: forged, now: NOW }))).toContain('digest-mismatch');
  });

  it('accepts a file that was reformatted, since the digest is over the readings and not the bytes', () => {
    // A mail gateway, an editor or a copy through a JSON tool may all re-serialise the file. None of
    // them changes a reading, and refusing them would make the feature unusable for the reason it is
    // least about.
    const built = envelope();
    const raw: Record<string, unknown> = { ...built, digest: digestOf(built.probes) };
    const reverse = (held: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(held).reverse());

    // Every key order reversed, at the top level and inside each probe. Canonicalisation sorts keys,
    // so this must not move the digest; if it does, the digest is over the serialisation rather than
    // over the readings and no file survives a round trip through any other tool.
    const reordered = {
      ...reverse(raw),
      probes: (raw.probes as Record<string, unknown>[]).map(reverse),
    };

    expect(assess({ envelope: envelopeFrom(reordered), now: NOW }).trusted).toBe(true);
  });
});

describe('the window a collection describes', () => {
  it('refuses one older than the window, and says how old', () => {
    const verdict = assess({ envelope: sealed({ generated_at: daysAgo(MAX_AGE_DAYS) }), now: NOW });

    expect(refusals(verdict)).toContain('expired');
    expect(verdict.refusals.find((note) => note.reason === 'expired')?.message).toContain('30 days ago');
  });

  it('accepts one on the last day of the window', () => {
    expect(refusals(assess({ envelope: sealed({ generated_at: daysAgo(MAX_AGE_DAYS - 1) }), now: NOW }))).toStrictEqual([]);
  });

  it('cautions rather than refuses once it is half-expired', () => {
    const verdict = assess({ envelope: sealed({ generated_at: daysAgo(STALE_AFTER_DAYS) }), now: NOW });

    expect(verdict.trusted).toBe(true);
    expect(cautions(verdict)).toContain('stale');
  });

  it('refuses one dated ahead of this clock, which is how a file never expires', () => {
    const ahead = new Date(NOW.getTime() + (MAX_SKEW_MINUTES + 5) * 60_000).toISOString().replace('.000Z', 'Z');
    const verdict = assess({ envelope: sealed({ generated_at: ahead }), now: NOW });

    expect(refusals(verdict)).toContain('future');
    // Not also reported as fresh-and-fine: an age that cannot be established is not an age.
    expect(verdict.ageHours).toBe(0);
  });

  it('tolerates a few minutes of clock skew, because two machines are two clocks', () => {
    const ahead = new Date(NOW.getTime() + 2 * 60_000).toISOString().replace('.000Z', 'Z');
    expect(refusals(assess({ envelope: sealed({ generated_at: ahead }), now: NOW }))).toStrictEqual([]);
  });
});

describe('which estate the file is about', () => {
  const target = { accountId: '00000000-1111-2222-3333-444444444444', workspaceIds: ['7000000000000001'] };

  it('refuses a file collected against another account', () => {
    const verdict = assess({
      envelope: sealed(),
      target: { ...target, accountId: 'ffffffff-1111-2222-3333-444444444444' },
      now: NOW,
    });

    expect(refusals(verdict)).toContain('wrong-account');
  });

  it('refuses a file collected against a workspace this assessment does not cover', () => {
    const verdict = assess({ envelope: sealed(), target: { ...target, workspaceIds: ['7000000000000009'] }, now: NOW });

    expect(refusals(verdict)).toContain('wrong-workspace');
  });

  it('compares workspace ids as strings, since both canonicalisers round above 2^53', () => {
    // The id here is longer than a double holds exactly. Compared as numbers it equals its neighbour;
    // compared as strings it does not, and the string comparison is the one that is right.
    const long = '9007199254740993';
    const neighbour = '9007199254740992';
    const held = sealed({
      tiers: {
        workspace: {
          ran: true,
          identity: { username: 'admin@example.com', host: 'https://x.cloud.databricks.com', workspace_id: long },
        },
        account: { ran: false },
      },
    });

    expect(refusals(assess({ envelope: held, target: { workspaceIds: [neighbour] }, now: NOW }))).toContain('wrong-workspace');
    expect(refusals(assess({ envelope: held, target: { workspaceIds: [long] }, now: NOW }))).toStrictEqual([]);
  });

  it('cautions when the app does not yet know what to compare against', () => {
    // The first assessment, before any scan: the account-plane requirements are exactly what this
    // import is for, so refusing here would withhold the feature in the case it exists for.
    const verdict = assess({ envelope: sealed(), now: NOW });

    expect(verdict.trusted).toBe(true);
    expect(cautions(verdict)).toContain('target-unverified');
  });

  it('does not claim the target is unverified once it has been checked', () => {
    expect(cautions(assess({ envelope: sealed(), target, now: NOW }))).not.toContain('target-unverified');
  });
});

describe('a file that has been imported before', () => {
  it('is refused, so a stale posture cannot be made to look maintained', () => {
    const held = sealed();
    const verdict = assess({ envelope: held, imported: new Set([held.digest]), now: NOW });

    expect(refusals(verdict)).toContain('replayed');
  });

  it('is not refused when what was imported before was a different collection', () => {
    const held = sealed();
    expect(refusals(assess({ envelope: held, imported: new Set([`sha256:${'0'.repeat(64)}`]), now: NOW }))).toStrictEqual([]);
  });
});

describe('the script that collected it', () => {
  it('cautions when the bytes differ from the copy this app publishes', () => {
    const verdict = assess({ envelope: sealed(), publishedScriptDigest: `sha256:${'c'.repeat(64)}`, now: NOW });

    expect(verdict.trusted).toBe(true);
    expect(cautions(verdict)).toContain('script-differs');
  });

  it('says nothing when they agree', () => {
    const held = sealed();
    expect(cautions(assess({ envelope: held, publishedScriptDigest: held.script.digest, now: NOW }))).not.toContain(
      'script-differs'
    );
  });
});

describe('what the file does not answer', () => {
  it('refuses a collection where neither tier ran', () => {
    const verdict = assess({
      envelope: sealed({
        tiers: { workspace: { ran: false, reason: 'not run' }, account: { ran: false, reason: 'not run' } },
        probes: [
          {
            signals: ['rest:workspace:preview.workspace-conf'],
            tier: 'workspace',
            label: 'workspace-conf',
            endpoint: 'GET /api/2.0/workspace-conf',
            controls: ['SCP-01-04'],
            fields: ['enableIpAccessLists'],
            shape: 'projected',
            status: 'skipped',
            detail: 'The workspace tier was not run.',
          },
        ],
      }),
      now: NOW,
    });

    expect(refusals(verdict)).toContain('nothing-collected');
  });

  it('counts the requirements a missing tier leaves unanswered, rather than saying a tier is missing', () => {
    const verdict = assess({ envelope: sealed(), now: NOW });
    const note = verdict.cautions.find((one) => one.reason === 'tier-not-run');

    expect(note?.message).toContain('The account tier was not run');
  });

  it('names the calls that were refused, since their requirements are unmeasured and not passing', () => {
    const verdict = assess({
      envelope: sealed({
        probes: [
          {
            signals: ['rest:workspace:dbfs.list'],
            tier: 'workspace',
            label: 'hive-warehouse',
            endpoint: 'GET /api/2.0/dbfs/list',
            controls: ['SCP-04-02'],
            fields: ['files[].path'],
            shape: 'projected',
            status: 'denied',
            detail: 'Public DBFS root is disabled. Access is denied on path',
          },
        ],
      }),
      now: NOW,
    });

    const note = verdict.cautions.find((one) => one.reason === 'probes-refused');
    expect(note?.message).toContain('hive-warehouse (denied)');
  });

  it('says when a tier that ran cannot be attributed to a person', () => {
    const verdict = assess({
      envelope: sealed({
        tiers: {
          workspace: { ran: true, identity: { username: 'admin@example.com', host: 'https://x.cloud.databricks.com' } },
          account: { ran: true, identity: { host: 'https://accounts.cloud.databricks.com', account_id: '00000000-1111-2222-3333-444444444444', read: 'text' } },
        },
      }),
      now: NOW,
    });

    const note = verdict.cautions.find((one) => one.reason === 'unattributed');
    expect(note?.message).toContain('account tier records no collecting user');
    expect(note?.message).toContain('expected');
  });
});

describe('a file with several things wrong with it', () => {
  it('reports all of them, because being told one at a time is a week per problem', () => {
    const original = sealed({ generated_at: daysAgo(MAX_AGE_DAYS + 5) });
    const edited: Envelope = { ...original, probes: [{ ...original.probes[0], value: { enableIpAccessLists: 'false' } }] };

    const verdict = assess({
      envelope: edited,
      target: { accountId: 'ffffffff-1111-2222-3333-444444444444', workspaceIds: ['7000000000000009'] },
      imported: new Set([digestOf(edited.probes)]),
      now: NOW,
    });

    expect(refusals(verdict)).toStrictEqual(
      expect.arrayContaining(['digest-mismatch', 'replayed', 'expired', 'wrong-account', 'wrong-workspace'])
    );
  });
});
