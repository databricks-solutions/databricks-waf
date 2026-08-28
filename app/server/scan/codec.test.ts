import { describe, expect, it } from 'vitest';
import { CODEC_VERSION, decodeScan, encodeScan, UnreadableScanError } from './codec.js';
import { CollectionScheduler } from './scheduler.js';
import type { Scan } from './scan.js';

function scan(overrides: Partial<Scan> = {}): Scan {
  const startedAt = new Date('2026-08-01T02:03:04.567Z');
  return {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    startedAt,
    finishedAt: new Date('2026-08-01T02:05:00.000Z'),
    state: 'complete',
    stamp: {
      publicMethodology: {
        publicVersion: 1,
        manifestDigest: 'sha256:public-methodology-version-1',
        state: 'candidate',
      },
      catalogueVersion: '3',
      catalogueFingerprint: 'abc123',
      executionMode: 'on-behalf-of-user',
      actor: 'someone@example.com',
      scope: { hostWorkspaceId: '123', description: 'the account' },
      lookbackDays: 30,
    },
    score: {
      overall: 56.5,
      pillars: [],
      counts: {
        pass: 1,
        fail: 0,
        partial: 0,
        unmeasurable: 0,
        'not-applicable': 0,
        'satisfied-by-architecture': 0,
      },
      scoredControls: 1,
      composition: { observed: 1, 'admin-collected': 0, attested: 0 },
      totalControls: 1,
    },
    findings: [
      {
        controlId: 'CO-01-01',
        pillarId: 'cost-optimization',
        principleId: 'CO-01',
        title: 'Something',
        outcome: 'pass',
        severity: 'medium',
        coverage: { mode: 'complete' },
        evidence: [
          {
            signal: 'sql:cost.tags',
            observed: '4 of 4',
            coverage: { mode: 'complete' },
            collectedAt: startedAt,
          },
        ],
      },
    ],
    signals: [
      {
        id: 'rest:workspace:preview.workspace-conf',
        status: 'observed',
        coverage: { mode: 'complete' },
        // The shape that cannot survive JSON, which is why values are not stored.
        value: { values: new Map([['enableIpAccessLists', 'true']]), unanswered: [] },
        collectedAt: startedAt,
        durationMs: 12,
      },
    ],
    estate: { assessed: [], excluded: [] },
    measurement: [
      {
        pillarId: 'cost-optimization',
        scanId: 'a1b2c3d4-0000-0000-0000-000000000000',
        measuredAt: new Date('2026-08-01T02:05:00.000Z'),
        actor: 'someone@example.com',
        carriedForward: false,
      },
    ],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
    ...overrides,
  };
}

describe('the scan codec', () => {
  it('brings back dates as dates, not the strings JSON left behind', () => {
    const decoded = decodeScan('x', encodeScan(scan()));

    expect(decoded.startedAt).toBeInstanceOf(Date);
    expect(decoded.startedAt.toISOString()).toBe('2026-08-01T02:03:04.567Z');
    expect(decoded.finishedAt).toBeInstanceOf(Date);
    expect(decoded.signals[0]?.collectedAt).toBeInstanceOf(Date);
    expect(decoded.findings[0]?.evidence[0]?.collectedAt).toBeInstanceOf(Date);
  });

  it('keeps everything a stored scan is read for', () => {
    const original = scan();
    const decoded = decodeScan('x', encodeScan(original));

    expect(decoded.id).toBe(original.id);
    expect(decoded.score.overall).toBe(56.5);
    expect(decoded.stamp).toEqual(original.stamp);
    expect(decoded.findings).toHaveLength(1);
    expect(decoded.findings[0]?.outcome).toBe('pass');
    expect(decoded.signals[0]?.status).toBe('observed');
  });

  it('drops raw signal values rather than storing them emptied', () => {
    const written = JSON.parse(encodeScan(scan())) as { scan: { signals: { value?: unknown }[] } };

    // The alternative is what JSON.stringify does unassisted: `value: {}`, which reads as
    // "the workspace had no settings" rather than "this was not stored".
    expect(written.scan.signals[0]).not.toHaveProperty('value');
    expect(decodeScan('x', encodeScan(scan())).signals[0]?.value).toBeUndefined();
  });

  it('brings per-pillar provenance back as dates too', () => {
    const decoded = decodeScan('x', encodeScan(scan()));

    expect(decoded.measurement[0]?.measuredAt).toBeInstanceOf(Date);
    expect(decoded.measurement[0]?.carriedForward).toBe(false);
  });

  it('refuses a file written by a version this build does not know', () => {
    const text = JSON.stringify({ codecVersion: CODEC_VERSION + 1, scan: scan() });

    expect(() => decodeScan('x', text)).toThrow(UnreadableScanError);
    expect(() => decodeScan('x', text)).toThrow(/encoding version/);
  });

  it('reads a scan written before per-pillar provenance existed, rather than dropping it', () => {
    // The failure this prevents is silent: a shape change that refused every older file
    // would empty the customer's history and look like scans had stopped being saved.
    const { measurement: _absent, ...old } = scan();
    const text = JSON.stringify({ codecVersion: 1, scan: old });

    const decoded = decodeScan('x', text);

    // Its own findings, measured by itself, which is what version 1 could only have meant.
    expect(decoded.measurement).toEqual([
      {
        pillarId: 'cost-optimization',
        scanId: old.id,
        measuredAt: old.finishedAt,
        actor: old.stamp.actor,
        carriedForward: false,
      },
    ]);
  });

  it('reads a version 3 scan without inventing a public methodology release', () => {
    // Version 4 added the optional public-methodology identity. A version 3 run cannot have carried
    // it, and catalogue revision 3 is technical provenance rather than evidence that the customer
    // Methodology Version 1 applied. Keeping the field absent is therefore the exact upgrade.
    const original = scan();
    const { publicMethodology: _absent, ...developmentStamp } = original.stamp;
    const text = JSON.stringify({
      codecVersion: 3,
      scan: { ...original, stamp: developmentStamp },
    });

    const decoded = decodeScan('version-3', text);

    expect(decoded.stamp.publicMethodology).toBeUndefined();
    expect(decoded.stamp.catalogueVersion).toBe('3');
  });

  it('reads a scan written before evidence classes, as a set that was observed except where answered', () => {
    // The number those scans carried is enough to reconstruct the composition exactly, because the
    // build that wrote them had one kind of collector and no way to import anything. Defaulting the
    // new field to zero instead would report a run that measured ninety requirements as having rested
    // on nothing, which is a worse reading of the same history than the one it replaced.
    const older = scan();
    const { composition: _absent, ...score } = older.score;
    const text = JSON.stringify({
      codecVersion: 1,
      scan: { ...older, score: { ...score, scoredControls: 9, attestedControls: 2 } },
    });

    const decoded = decodeScan('x', text).score;

    expect(decoded.composition).toEqual({ observed: 7, 'admin-collected': 0, attested: 2 });
    // Dropped rather than carried, so what the API serves has the shape the contract declares.
    expect(decoded).not.toHaveProperty('attestedControls');
  });

  it('reconstructs a pillar composition from the attested count that pillar carried', () => {
    const older = scan();
    const text = JSON.stringify({
      codecVersion: 1,
      scan: {
        ...older,
        score: {
          ...older.score,
          composition: undefined,
          pillars: [{ pillarId: 'cost-optimization', scored: 5, attested: 1 }],
        },
      },
    });

    const pillar = decodeScan('x', text).score.pillars[0];

    expect(pillar?.composition).toEqual({ observed: 4, 'admin-collected': 0, attested: 1 });
    expect(pillar).not.toHaveProperty('attested');
  });

  it('leaves a composition alone when the scan already recorded one', () => {
    expect(decodeScan('x', encodeScan(scan())).score.composition).toEqual({
      observed: 1,
      'admin-collected': 0,
      attested: 0,
    });
  });

  it('refuses a truncated file rather than returning half a scan', () => {
    expect(() => decodeScan('x', encodeScan(scan()).slice(0, 200))).toThrow(UnreadableScanError);
  });

  it('refuses a scan whose date will not parse, rather than dating it now', () => {
    const text = JSON.stringify({ codecVersion: CODEC_VERSION, scan: { ...scan(), startedAt: 'never' } });

    expect(() => decodeScan('x', text)).toThrow(/startedAt is not a date/);
  });

  it('refuses a file that is valid JSON but not a scan', () => {
    const text = JSON.stringify({ codecVersion: CODEC_VERSION, scan: { hello: 'world' } });

    expect(() => decodeScan('x', text)).toThrow(/missing the id, stamp or score/);
  });

  // The document below is written out rather than derived from `CollectionScheduler`, and that is the
  // whole point of it. Every other fixture in this file gets its footprint from `new
  // CollectionScheduler().footprint()`, which carries whatever the current build carries — so a fixture
  // built that way cannot disagree with the code under test about shape, and that is exactly why row 81
  // shipped a stored-shape change with a green suite. This is a literal of what was on labs.
  const preRow81 = {
    spend: {
      spent: { sql: 28, describe: 49, rest: 2 },
      limits: { sql: 400, describe: 4000, rest: 200 },
      elapsedMs: 187_000,
    },
    // Five counts and no `terminal`, which is what every surface looked like before row 81.
    tasks: { sql: { ok: 28, skipped: 0, failed: 0, retries: 0, attempts: 28 } },
    limiters: {},
    exhaustion: undefined,
    cancelled: false,
  };

  it('refuses a scan stored before row 81 added terminal, rather than throwing where it is rendered', () => {
    // What this prevents is measured: on 2026-08-17 all 24 scans in the labs schema were this shape,
    // `presentFootprint` called `Object.entries` on the absent field, and the app exited 2m38s after
    // start and returned 502 on every route until it was redeployed by hand.
    const text = JSON.stringify({ codecVersion: 2, scan: { ...scan(), footprint: preRow81 } });

    expect(() => decodeScan('x', text)).toThrow(UnreadableScanError);
    expect(() => decodeScan('x', text)).toThrow(/sql counters have no terminal/);
  });

  it('reads the same document once it carries the field, so what is refused is the shape and not the version', () => {
    // Version 2 named two shapes. The one that carries `terminal` is what this build writes, so
    // refusing every version 2 document would discard readable history to punish a number.
    const text = JSON.stringify({
      codecVersion: 2,
      scan: {
        ...scan(),
        footprint: { ...preRow81, tasks: { sql: { ...preRow81.tasks.sql, terminal: { throttled: 3 } } } },
      },
    });

    expect(decodeScan('x', text).footprint.tasks.sql?.terminal).toEqual({ throttled: 3 });
  });

  it('refuses a scan with no footprint at all, rather than serving a record read from nothing', () => {
    const { footprint: _absent, ...withoutOne } = scan();
    const text = JSON.stringify({ codecVersion: CODEC_VERSION, scan: withoutOne });

    expect(() => decodeScan('x', text)).toThrow(/carries no footprint/);
  });
});
