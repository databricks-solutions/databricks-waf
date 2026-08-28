import { describe, expect, it } from 'vitest';
import {
  cutoffFor,
  DEFAULT_PERIOD_DAYS,
  EXEMPT,
  holdRefusal,
  holdsOver,
  MAX_PERIOD_DAYS,
  periodRefusal,
  planRetention,
  RETAINED,
  RETENTION_CLASSES,
  sweepRetention,
  type Eligibility,
  type LegalHold,
  type RetentionGateway,
  type RetentionPolicy,
} from './retention.js';
import { FakePostgres } from '../store/postgres-fake.js';
import { ensureSchema } from '../store/postgres.js';

const NOW = new Date('2026-08-04T00:00:00.000Z');

/** A gateway over declared row counts, so a plan can be asserted without a schema. */
class Gateway implements RetentionGateway {
  readonly removals: { table: string; before: Date }[] = [];
  trimmed?: { before: Date; by: string };
  /** Set when the plan counted the chained table, so the test can assert it did not count by age. */
  countedPrefix = false;

  constructor(
    private readonly rows: Readonly<Record<string, { total: number; eligible: number; oldest?: Date }>> = {},
    private readonly floor?: number
  ) {}

  count(table: string, _stamp: string, before?: Date): Promise<Eligibility> {
    const found = this.rows[table] ?? { total: 0, eligible: 0 };
    return Promise.resolve({
      table,
      total: found.total,
      eligible: before == null ? 0 : found.eligible,
      ...(found.oldest != null ? { oldest: found.oldest } : {}),
    });
  }

  countAuditPrefix(before: Date): Promise<Eligibility> {
    this.countedPrefix = true;
    return this.count('audit_events', 'at', before);
  }

  remove(table: string, _stamp: string, before: Date): Promise<number> {
    this.removals.push({ table, before });
    return Promise.resolve(this.rows[table]?.eligible ?? 0);
  }

  trimAuditPrefix(before: Date, by: string): Promise<{ removed: number; floor?: number }> {
    this.trimmed = { before, by };
    return Promise.resolve({
      removed: this.rows.audit_events?.eligible ?? 0,
      ...(this.floor != null ? { floor: this.floor } : {}),
    });
  }
}

const POLICY: RetentionPolicy = { periods: DEFAULT_PERIOD_DAYS };

function hold(covers: LegalHold['covers'], released = false): LegalHold {
  return {
    id: 'hold-1',
    reason: 'Litigation over the 2025 audit',
    covers,
    placedBy: 'priya@example.com',
    placedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...(released ? { releasedBy: 'priya@example.com', releasedAt: new Date('2026-06-01T00:00:00.000Z') } : {}),
  };
}

describe('what retention is declared over', () => {
  it('classifies every retained table as one of the three classes', () => {
    for (const one of RETAINED) {
      expect(RETENTION_CLASSES).toContain(one.retentionClass);
    }
  });

  it('never measures age from when this app wrote the row', () => {
    // `written_at` is when the row arrived here, which for an imported collection is months after the
    // evidence was collected. A period is a statement about the age of the information.
    for (const one of RETAINED) {
      expect(one.stamp).not.toBe('written_at');
    }
  });

  it('sweeps the audit log last, so the record of the sweep is written before the log is trimmed', () => {
    expect(RETAINED.at(-1)?.table).toBe('audit_events');
  });

  it('gives every exempt table a reason, since an unexplained exemption reads as an oversight', () => {
    for (const one of EXEMPT) {
      expect(one.because.length).toBeGreaterThan(40);
    }
  });

  it('does not both retain and exempt the same table', () => {
    const retained = new Set(RETAINED.map((one) => one.table));
    for (const one of EXEMPT) expect(retained.has(one.table)).toBe(false);
  });

  it('accounts for every table the app creates, so a new one cannot quietly escape a period', async () => {
    // The gap this closes is the one a reviewer cannot see. Adding a table is a schema change in one
    // file and a retention decision in another, and nothing but this test connects them — so a table
    // holding somebody's name and kept forever would have shipped green, with the retention page
    // still reporting the same confident list of what it deletes.
    //
    // Deciding is what is required, not retaining: a table can be exempt, as long as the exemption is
    // written down with a reason. What is refused is silence.
    const fake = new FakePostgres();
    await ensureSchema(fake, fake.schema);

    const created = fake.statements
      .map((sql) => /^create table if not exists \S+\.(\w+)/.exec(sql)?.[1])
      .filter((name) => name != null);

    const accounted = new Set([...RETAINED.map((one) => one.table), ...EXEMPT.map((one) => one.table), ...SETTINGS]);
    expect(created.filter((table) => !accounted.has(table))).toEqual([]);
  });
});

/**
 * Tables that hold the retention decision itself, rather than anything it applies to.
 *
 * Sweeping the periods would restore the defaults, and sweeping the holds would remove the record of
 * why something was kept. Both are the machinery of retention and neither is evidence, so they are
 * named here rather than given an entry in `EXEMPT`, which is about records a customer might expect
 * to be deleted and finds are not.
 */
const SETTINGS = ['retention_periods', 'legal_holds', 'audit_floor'];

describe('planning what a period makes eligible', () => {
  it('reports the total and the oldest row beside the eligible count, so the period can be judged', async () => {
    const gateway = new Gateway({ scans: { total: 40, eligible: 9, oldest: new Date('2023-04-01T00:00:00.000Z') } });

    const plan = await planRetention(gateway, POLICY, [], NOW);
    const assessment = plan.classes.find((one) => one.retentionClass === 'assessment');
    const scans = assessment?.tables.find((one) => one.table === 'scans');

    expect(scans).toMatchObject({ total: 40, eligible: 9 });
    expect(scans?.oldest?.toISOString()).toBe('2023-04-01T00:00:00.000Z');
    expect(scans?.holds).toContain('Completed runs');
  });

  it('counts the chained log the way a trim cuts it, rather than by age', async () => {
    const gateway = new Gateway({ audit_events: { total: 60, eligible: 12 } });

    await planRetention(gateway, POLICY, [], NOW);

    // The two have to be the same rule. Counting the log by age would report events a trim will not
    // take — the ones sequenced above an event that must be kept — and the sweep's confirmation would
    // then be against a number that cannot happen.
    expect(gateway.countedPrefix).toBe(true);
  });

  it('cuts each class at its own period', async () => {
    const plan = await planRetention(new Gateway(), POLICY, [], NOW);

    const temporary = plan.classes.find((one) => one.retentionClass === 'temporary');
    expect(temporary?.cutoff.toISOString()).toBe(cutoffFor(30, NOW).toISOString());
    expect(plan.classes.find((one) => one.retentionClass === 'governance')?.periodDays).toBe(2555);
  });

  it('honours a configured period over the default', async () => {
    const plan = await planRetention(new Gateway(), { periods: { ...DEFAULT_PERIOD_DAYS, temporary: 7 } }, [], NOW);

    expect(plan.classes.find((one) => one.retentionClass === 'temporary')?.periodDays).toBe(7);
  });

  it('counts nothing towards removal for a class a hold covers', async () => {
    const rows = { scans: { total: 10, eligible: 4 }, assessment_setup_drafts: { total: 3, eligible: 3 } };

    const unheld = await planRetention(new Gateway(rows), POLICY, [], NOW);
    const held = await planRetention(new Gateway(rows), POLICY, [hold(['assessment'])], NOW);

    expect(unheld.wouldRemove).toBe(7);
    expect(held.wouldRemove).toBe(3);
  });

  it('still reports what a held class would remove, since a hold and an unaged period are different facts', async () => {
    const plan = await planRetention(new Gateway({ scans: { total: 10, eligible: 4 } }), POLICY, [hold(['assessment'])], NOW);
    const assessment = plan.classes.find((one) => one.retentionClass === 'assessment');

    expect(assessment?.heldBy.map((one) => one.id)).toEqual(['hold-1']);
    expect(assessment?.tables.find((one) => one.table === 'scans')?.eligible).toBe(4);
  });

  it('treats a released hold as history that stops nothing', async () => {
    const plan = await planRetention(
      new Gateway({ scans: { total: 10, eligible: 4 } }),
      POLICY,
      [hold(['assessment'], true)],
      NOW
    );

    expect(plan.wouldRemove).toBe(4);
    expect(holdsOver('assessment', [hold(['assessment'], true)])).toEqual([]);
  });
});

describe('sweeping', () => {
  it('removes each retained table at its own class cutoff', async () => {
    const gateway = new Gateway({ scans: { total: 10, eligible: 4 }, decisions: { total: 2, eligible: 1 } });

    const sweep = await sweepRetention(gateway, POLICY, [], 'priya@example.com', NOW);

    expect(sweep.removed).toBe(5);
    expect(gateway.removals.find((one) => one.table === 'scans')?.before.toISOString()).toBe(
      cutoffFor(730, NOW).toISOString()
    );
    expect(gateway.removals.find((one) => one.table === 'decisions')?.before.toISOString()).toBe(
      cutoffFor(2555, NOW).toISOString()
    );
  });

  it('skips a held class whole, and says which hold kept it', async () => {
    const gateway = new Gateway({ scans: { total: 10, eligible: 4 }, imported_evidence: { total: 6, eligible: 6 } });

    const sweep = await sweepRetention(gateway, POLICY, [hold(['assessment'])], 'priya@example.com', NOW);

    expect(sweep.removed).toBe(0);
    expect(gateway.removals.map((one) => one.table)).not.toContain('scans');
    expect(sweep.held).toEqual([{ retentionClass: 'assessment', holds: ['hold-1'] }]);
  });

  it('trims the audit log through the prefix path rather than by deleting on age', async () => {
    const gateway = new Gateway({ audit_events: { total: 100, eligible: 40 } }, 40);

    const sweep = await sweepRetention(gateway, POLICY, [], 'priya@example.com', NOW);

    expect(gateway.trimmed).toMatchObject({ by: 'priya@example.com' });
    expect(gateway.removals.map((one) => one.table)).not.toContain('audit_events');
    expect(sweep.auditFloor).toBe(40);
  });

  it('carries no audit floor when the trim removed nothing', async () => {
    const sweep = await sweepRetention(new Gateway(), POLICY, [], 'priya@example.com', NOW);

    expect(sweep.auditFloor).toBeUndefined();
    expect(sweep.removed).toBe(0);
  });

  it('leaves the audit log alone when a hold covers governance', async () => {
    const gateway = new Gateway({ audit_events: { total: 100, eligible: 40 } }, 40);

    await sweepRetention(gateway, POLICY, [hold(['governance'])], 'priya@example.com', NOW);

    expect(gateway.trimmed).toBeUndefined();
  });
});

describe('refusing a period', () => {
  it('refuses anything that is not a whole number of days', () => {
    expect(periodRefusal(30.5)).toMatch(/whole number/);
    expect(periodRefusal('30')).toMatch(/whole number/);
    expect(periodRefusal(Number.NaN)).toMatch(/whole number/);
  });

  it('refuses a period that would delete records as fast as they are written', () => {
    expect(periodRefusal(0)).toMatch(/as fast as they are written/);
    expect(periodRefusal(-1)).toMatch(/as fast as they are written/);
  });

  it('refuses a period longer than the app can promise', () => {
    expect(periodRefusal(MAX_PERIOD_DAYS + 1)).toMatch(/hundred years/);
  });

  it('accepts the defaults it ships with', () => {
    for (const days of Object.values(DEFAULT_PERIOD_DAYS)) expect(periodRefusal(days)).toBeUndefined();
  });
});

describe('refusing a hold', () => {
  it('insists on a reason, because whoever lifts it will not be whoever placed it', () => {
    expect(holdRefusal('', ['assessment'])).toMatch(/reason/);
    expect(holdRefusal('audit', ['assessment'])).toMatch(/ten characters/);
  });

  it('insists on a scope', () => {
    expect(holdRefusal('Litigation over the 2025 audit', [])).toMatch(/at least one of/);
    expect(holdRefusal('Litigation over the 2025 audit', 'assessment')).toMatch(/at least one of/);
  });

  it('names the classes when asked to hold something the app does not retain', () => {
    expect(holdRefusal('Litigation over the 2025 audit', ['everything'])).toMatch(/is not something this app retains/);
  });

  it('accepts a hold over every class', () => {
    expect(holdRefusal('Litigation over the 2025 audit', [...RETENTION_CLASSES])).toBeUndefined();
  });
});
