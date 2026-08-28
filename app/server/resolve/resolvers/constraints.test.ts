// Delta CHECK constraints, and the line between what this reading settles and what it hands back.
//
// The claim these tests defend is that presence is the only verdict. A sampled table carrying a
// `delta.constraints.*` property is enforcing a rule at the write, and enough of them is a pass; but
// the absence of one is not a failure, because a pipeline expectation or a column NOT NULL enforces
// the same way and neither is in this signal. So none-found is unmeasured and goes to a person, and
// the source is the per-table describe rather than `information_schema.check_constraints` — the view
// that publishes the columns and no rows, which the first pass at this named and measured nothing.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { TableDetail, TableDetails } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const DETAILS = 'describe:storage.table_details' as SignalId;
const catalogue = loadCatalogue();
const registry = buildRegistry();

function table(properties: Readonly<Record<string, string>> = {}, name = 'orders'): TableDetail {
  return {
    catalog: 'main',
    schema: 'sales',
    table: name,
    sizeBytes: 4 * 1024 ** 4,
    fileCount: 200,
    partitionColumns: [],
    clusteringColumns: [],
    features: ['appendOnly'],
    automaticClustering: false,
    properties,
    readEvents: 5,
  };
}

function findingFor(tables: readonly TableDetail[], eligibleTables = 400) {
  const spec = catalogue.controls.find((control) => control.id === 'REL-02-04');
  if (spec == null) throw new Error('REL-02-04 is not in the catalogue');
  const details: TableDetails = { tables, eligibleTables, undescribed: [] };
  const signals = new Map<SignalId, SignalResult>([
    [DETAILS, observed(DETAILS, details, 1, { mode: 'sampled', examined: tables.length, population: eligibleTables })],
  ]);
  return resolveControl(spec, signals, registry.get('REL-02-04'));
}

describe('constraints declared on the sampled tables', () => {
  it('passes when a strong share of the sample declares a CHECK constraint', () => {
    const finding = findingFor([
      table({ 'delta.constraints.amount_positive': 'amount > 0' }),
      table({ 'delta.constraints.status_known': "status IN ('open','closed')" }, 'tickets'),
    ]);

    expect(finding.outcome).toBe('pass');
    // The clause is the evidence: a reader wants the rule, not just the count.
    expect(finding.evidence[0].observed).toContain('amount_positive (amount > 0)');
    expect(finding.evidence[0].observed).toContain('main.sales.orders');
  });

  it('does not score a shortfall against tables whose rules it cannot read', () => {
    // This was a `partial`, and the shortfall behind it was the two tables carrying no CHECK
    // constraint — the claim this resolver's own header says the signal cannot support. One table
    // with a constraint took the estate from unmeasured to scored on that reasoning.
    const finding = findingFor([
      table({ 'delta.constraints.amount_positive': 'amount > 0' }),
      table({}, 'customers'),
      table({}, 'events'),
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('attestation');
    expect(finding.remedy?.kind).toBe('attest');
    // What it did read is still reported: the constraint it found, and where.
    expect(finding.outcomeReason).toContain('main.sales.orders');
    expect(finding.outcomeReason).toContain('amount_positive (amount > 0)');
  });

  it('does not say most tables lack a constraint over a share where most carry one', () => {
    // Any share under the pass bar took the same sentence, "most do not", including this one.
    const finding = findingFor([
      table({ 'delta.constraints.a': 'x > 0' }),
      table({ 'delta.constraints.b': 'y > 0' }, 'tickets'),
      table({ 'delta.constraints.c': 'z > 0' }, 'invoices'),
      table({}, 'events'),
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).not.toContain('most do not');
  });

  it('hands none-found to a person rather than failing it', () => {
    // The whole point of the design: absence is not evidence of absence, because expectations and
    // NOT NULL enforce the same way and are not in this signal. So it is unmeasured, of the kind that
    // attaches an answer remedy and lists the requirement on the answers page.
    const finding = findingFor([table({}, 'customers'), table({}, 'events')]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('attestation');
    expect(finding.remedy?.kind).toBe('attest');
    expect(finding.outcomeReason).toContain('expectations');
    expect(finding.outcomeReason).toContain('NOT NULL');
  });

  it('does not count the informational keys Unity Catalog records without enforcing', () => {
    // A table carrying only unrelated properties is treated as declaring no CHECK constraint. Primary
    // and foreign keys are not in the properties map at all, so this is the nearest the fixture can get
    // to the informational-key case the catalogue warns about.
    const finding = findingFor([table({ 'delta.enableDeletionVectors': 'true' })]);

    expect(finding.outcome).toBe('unmeasurable');
  });

  it('reads only the per-table describe, never information_schema', () => {
    // The negative result is the finding, so the view must not creep back in as a second source: the
    // resolver depends on the describe signal and nothing else.
    const resolver = registry.get('REL-02-04');
    expect(resolver?.requires).toEqual([DETAILS]);
  });

  it('leaves the denominator when the metastore holds no Delta tables', () => {
    expect(findingFor([], 0).outcome).toBe('not-applicable');
  });

  it('reports unmeasured, not clean, when eligible tables went undescribed', () => {
    expect(findingFor([], 400).outcome).toBe('unmeasurable');
  });

  it('carries the sample coverage, so a pass is not read as estate-wide', () => {
    const finding = findingFor([table({ 'delta.constraints.amount_positive': 'amount > 0' })]);
    expect(finding.evidence[0].coverage.mode).toBe('sampled');
    expect(COMPLETE.mode).toBe('complete');
  });
});
