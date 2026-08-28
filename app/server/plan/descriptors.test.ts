// The descriptors against the collectors they describe.
//
// This file is the reason the requirements page can be trusted. The page tells an admin what
// the app will execute and what to grant it, and every fact on it comes from somewhere else:
// a signal list from the collectors, a table list from the shipped SQL, a dependency from the
// collector's own `requires`. Any of those can move without the descriptors moving with them,
// and the result would not look broken — it would look like a shorter list.
//
// So the pairing is asserted in both directions, and the dependencies are asserted against
// collector instances rather than against a second written statement of them.

import { describe, expect, it } from 'vitest';
import { DescribeCollector } from '../collect/sql/describe.js';
import { PredictiveOptimizationCollector } from '../collect/sql/predictive-optimization.js';
import { RestCollector } from '../collect/rest/collector.js';
import { CloudCollector } from '../collect/cloud/collector.js';
import { SqlCollector } from '../collect/sql/collector.js';
import { accountScope } from '../collect/estate-scope.js';
import type { Collector, SignalId } from '../collect/signal.js';
import { schemasOf, tablesRead } from '../collect/sql/reads.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { signalDescriptors } from './descriptors.js';
import { buildPlan } from './plan.js';

/**
 * The collectors as the app builds them, with their outbound edges stubbed.
 *
 * Instances rather than the exported signal-list constants, because what is being checked
 * includes each collector's `requires`, and that is an instance field. A stub executor is
 * enough: nothing here collects anything.
 */
function collectors(): readonly Collector[] {
  const executor = () => Promise.resolve([]);
  return [
    new SqlCollector({ executor, scope: accountScope('1') }),
    new DescribeCollector({ executor }),
    new PredictiveOptimizationCollector({ executor }),
    new RestCollector({ client: () => Promise.reject(new Error('not called')) }),
    new CloudCollector(),
  ];
}

const descriptors = signalDescriptors();
const described = new Set(descriptors.map((descriptor) => descriptor.id));

describe('the signal descriptors', () => {
  it('describe every signal a collector can produce', () => {
    const produced = collectors().flatMap((collector) => collector.signals);
    const missing = produced.filter((signal) => !described.has(signal));

    // Named rather than counted, because the fix is per signal: a collector gained a signal
    // and the requirements page would have omitted the work it does.
    expect(missing, 'signals with no descriptor').toEqual([]);
  });

  it('describe nothing no collector produces', () => {
    const produced = new Set(collectors().flatMap((collector) => collector.signals));
    const orphans = [...described].filter((signal) => !produced.has(signal));

    // The opposite drift, and the more dangerous one: a descriptor for a signal that no longer
    // exists tells an admin the app reads something it does not, which is the kind of error
    // that survives review because it errs towards asking for more permission, not less.
    expect(orphans, 'descriptors for signals nothing produces').toEqual([]);
  });

  it('describe every signal a resolver asks for', () => {
    // The other end of the same drift, and the one that fails silently on the page rather than
    // in a scan: a resolver can require a signal that is collected and scored perfectly while
    // the requirements page omits the statement that produced it, so an admin grants less than
    // the app needs and blames the app for the gap.
    const registry = buildRegistry();
    const controls = loadCatalogue()
      .pillars.flatMap((pillar) => pillar.principles)
      .flatMap((principle) => principle.controls)
      .map((control) => control.id);

    const missing = registry.signalsFor(controls).filter((signal) => !described.has(signal));

    expect(missing, 'signals a resolver reads with no descriptor').toEqual([]);
  });

  it('record the same dependencies the collectors declare', () => {
    for (const collector of collectors()) {
      const inputs = [...(collector.requires ?? [])];
      for (const signal of collector.signals) {
        const descriptor = descriptors.find((candidate) => candidate.id === signal);
        const expected = inputs.filter((input) => input !== signal);
        expect(
          [...(descriptor?.derivedFrom ?? [])].sort(),
          `${signal} is collected after ${expected.join(', ') || 'nothing'}`
        ).toEqual(expected.sort());
      }
    }
  });

  it('say what every signal observes', () => {
    const silent = descriptors.filter((descriptor) => descriptor.observes.trim() === '').map((d) => d.id);
    expect(silent, 'signals with no description').toEqual([]);
  });

  it('name a resource for every signal', () => {
    // A signal touching nothing is either a descriptor that forgot to say, or a check that
    // reads no resource at all. Both are worth failing on: the page's whole subject is what
    // the app contacts.
    const untraced = descriptors.filter((descriptor) => descriptor.touches.length === 0).map((d) => d.id);
    expect(untraced, 'signals naming no resource').toEqual([]);
  });

  it('derive the tables a statement reads from the statement, including shared fragments', () => {
    const profile = descriptors.find((descriptor) => descriptor.id === 'sql:estate.compute_profile');
    expect(profile?.touches).toContain('system.billing.usage');

    // The customer-catalog fragment reads the catalog list, and it is expanded into whichever
    // query references it. Deriving from the expanded text is what makes that visible; a
    // hand-written table list would have omitted it, and an admin would have been told the
    // census reads one schema when it reads two.
    const census = descriptors.find((descriptor) => descriptor.id === 'sql:uc.census');
    expect(census?.touches).toContain('system.information_schema.catalogs');
    expect(census?.touches).toContain('system.information_schema.tables');
  });
});

describe('reading a statement', () => {
  it('finds three-part names after from and join, in any case', () => {
    expect(tablesRead('SELECT * FROM system.billing.usage u JOIN System.Access.Audit a ON true')).toEqual([
      'system.access.audit',
      'system.billing.usage',
    ]);
  });

  it('ignores names that are not tables anyone can grant on', () => {
    // A CTE is not a securable, and reporting `totals` as a resource the app reads would put a
    // name on the requirements page that the reader cannot look up or grant.
    expect(tablesRead('WITH totals AS (SELECT 1) SELECT * FROM totals')).toEqual([]);
  });

  it('reduces tables to the schema a grant is made on', () => {
    expect(schemasOf(['system.billing.usage', 'system.billing.list_prices', 'system.access.audit'])).toEqual([
      'system.access',
      'system.billing',
    ]);
  });
});

describe('the plan', () => {
  const plan = buildPlan({
    catalogue: loadCatalogue(),
    registry: buildRegistry(),
    measuredPillars: ['cost-optimization'],
    descriptors,
  });

  it('covers every pillar in the catalogue, measured or not', () => {
    expect(plan.pillars.length).toBeGreaterThan(1);
    expect(plan.pillars.filter((pillar) => pillar.measured).map((pillar) => pillar.pillarId)).toEqual([
      'cost-optimization',
    ]);
  });

  it('includes the signals a pillar needs and the inputs those need', () => {
    const cost = plan.pillars.find((pillar) => pillar.pillarId === 'cost-optimization');
    const directory = cost?.signals.find((signal) => signal.id === ('sql:estate.workspaces' as SignalId));

    // The directory is the case this closure exists for: no requirement reads it, every
    // account-wide statement filters on it, and a plan built only from what resolvers ask for
    // would omit the one statement whose failure silently widens every count.
    expect(directory, 'the workspace directory is planned').toBeDefined();
    expect(directory?.input).toBe(true);
    expect(directory?.answers).toEqual([]);
  });

  it('attributes each signal to the requirements it serves', () => {
    const cost = plan.pillars.find((pillar) => pillar.pillarId === 'cost-optimization');
    const answering = cost?.signals.filter((signal) => signal.answers.length > 0) ?? [];

    expect(answering.length).toBeGreaterThan(0);
    for (const signal of answering) {
      for (const controlId of signal.answers) {
        expect(controlId.startsWith('CO-'), `${controlId} belongs to the pillar it is listed under`).toBe(true);
      }
    }
  });

  it('counts what a run costs per surface against what it may spend', () => {
    const cost = plan.pillars.find((pillar) => pillar.pillarId === 'cost-optimization');
    const sql = cost?.cost.find((surface) => surface.surface === 'sql');

    expect(sql?.fixed).toBeGreaterThan(0);
    expect(sql?.budget).toBeGreaterThan(sql?.fixed ?? 0);
  });

  it('states the grants its statements need, once each', () => {
    const cost = plan.pillars.find((pillar) => pillar.pillarId === 'cost-optimization');
    const grants = cost?.requires.filter((requirement) => requirement.kind === 'metastore-grant') ?? [];

    expect(grants.map((grant) => grant.what)).toContain('SELECT on system.billing');
    expect(new Set(grants.map((grant) => grant.what)).size, 'no grant listed twice').toBe(grants.length);
  });

  it('separates requirements no install can measure from ones nobody has built', () => {
    const security = plan.pillars.find((pillar) => pillar.pillarId === 'security-compliance-and-privacy');

    // Both counts matter and they call for opposite responses: the scope-blocked ones are a
    // platform limit to attest around, the unbuilt ones are our backlog. A single "unmeasured"
    // number would invite an issue for one and silence about the other.
    expect(security?.blockedControls).toBeGreaterThan(0);

    // A subset of the checks that exist, which is what makes the checks page's subtraction valid.
    // The requirements that are equally unreachable and never had a check written are counted as
    // `unanswered.unreachable` instead — if they leaked in here, "requirements decided by the
    // checks below" would go negative, which it did before the two were separated.
    expect(security?.blockedControls).toBeLessThanOrEqual(security?.answeredControls ?? 0);
    expect(security?.unanswered.unreachable).toBeGreaterThan(0);
  });

  it('promises no check it cannot deliver', () => {
    // The defect this pair of counts was introduced for. Every `planned` requirement is one the app
    // could be authorised to read, so a reader chasing the roadmap for it is chasing something real.
    // Anything the platform refuses belongs in `unreachable`, whose sentence tells them to answer it
    // themselves. Asserted across every pillar rather than security alone, because the next
    // catalogue import will land wherever it lands.
    for (const pillar of plan.pillars) {
      const promised = pillar.unanswered.planned;
      expect(promised, `${pillar.pillarId} promises ${String(promised)} checks`).toBeLessThanOrEqual(
        pillar.totalControls
      );
    }
    const security = plan.pillars.find((pillar) => pillar.pillarId === 'security-compliance-and-privacy');
    expect(security?.unanswered.planned, 'the security pillar had 37 unkeepable promises').toBe(0);
  });

  it('leaves no requirement in the backlog, in either pillar or anywhere else', () => {
    // What "phase 3 resolvers is done" means, asserted rather than declared. Every requirement is
    // now in one of three states and none of them is a promise: 84 have a check, 37 name an
    // endpoint no install of this app can call, and 63 describe a practice no API reports.
    //
    // This is the guard on that claim rather than a restatement of it. Both remaining buckets have
    // a sentence for the reader — re-authorise, or answer it yourself — and `planned` is the one
    // that does not: it says a check is coming, which is only true while somebody is writing it.
    // So a catalogue import that lands a requirement in `planned`, or a resolver deleted out from
    // under one, fails here rather than appearing on the checks page as work in progress.
    const backlog = plan.pillars.flatMap((pillar) =>
      pillar.unanswered.planned + pillar.unanswered.unimplemented > 0
        ? [`${pillar.pillarId}: ${String(pillar.unanswered.planned)} planned, ${String(pillar.unanswered.unimplemented)} unimplemented`]
        : []
    );
    expect(backlog, 'every requirement is measured, unreachable, or a question for a person').toEqual([]);
  });

  it('accounts for every requirement in the pillar', () => {
    // The numbers on the page have to add up to the pillar, or a reader who checks will find a
    // remainder and no explanation of it. Blocked is deliberately excluded from the sum, being a
    // subset of answered rather than another category.
    for (const pillar of plan.pillars) {
      const { attestation, unreachable, planned, unimplemented } = pillar.unanswered;
      expect(pillar.answeredControls + attestation + unreachable + planned + unimplemented, pillar.pillarId).toBe(
        pillar.totalControls
      );
    }
  });
});
