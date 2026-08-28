// The empty estate.
//
// A statement that matches no rows still returns a row of zeroes, and a resolver that
// divides one count by another gets a number rather than an error. So an estate nobody
// can see — a metastore with no readable tables, an audit window that caught nothing, a
// storage snapshot that has not populated — arrives at the resolvers looking exactly like
// a compliant one. Zero over-partitioned tables out of zero examined is arithmetically a
// pass; zero tables with deletion vectors out of zero examined is arithmetically a
// failure. Same absence of evidence, two fabricated findings in opposite directions.
//
// This is not hypothetical. `system.storage.table_metrics_history` was present and empty
// on the workspace this app was developed against, and an estate of zero bytes would have
// been a fabrication rather than a measurement. That one was caught in the resolver that
// hit it. This test is here so the next one is caught by construction: every resolver is
// fed the value its own parser produces from zero rows, and none of them is allowed to
// reach a scored outcome from it.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { REQUESTED_KEYS, SETTING_KEYS } from '../../collect/rest/settings-keys.js';
import { observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import { emptySqlSignal } from '../../collect/sql/collector.js';
import type { Outcome } from '../finding.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();

/**
 * Empty values for signals no SQL parser produces.
 *
 * The per-object surfaces, whose values their collectors assemble across many statements
 * rather than parsing from one. Literals, so a shape change fails typecheck here.
 *
 * Deliberately harder than what those collectors actually do. Both report the signal
 * unmeasurable when they find nothing to describe, and an unmeasurable signal
 * short-circuits before any resolver logic runs — so testing that would test the
 * short-circuit. Handing the resolvers a fully-populated shape holding nothing tests the
 * arithmetic that would otherwise turn zero-over-zero into a finding.
 */
const ASSEMBLED: Readonly<Record<string, unknown>> = {
  'describe:storage.table_details': { tables: [], eligibleTables: 0, undescribed: [] },
  'describe:predictive_optimization.coverage': {
    managedTables: 0,
    enabledTables: 0,
    catalogs: [],
    unreadable: [],
    // What the collector's own summariser returns for no catalogs, and the distinction
    // this suite exists to hold: not `disabled`, which would read as an estate that
    // switched predictive optimization off and would put the VACUUM control back in the
    // score demanding maintenance for tables that do not exist.
    state: 'unknown',
    summary: 'unknown',
  },
  // A workspace that has never set any of its security settings. Every requested key is
  // answered and every answer is null, which is what the endpoint returns for a workspace
  // nobody has configured — not an absence of data.
  'rest:workspace:preview.workspace-conf': {
    values: new Map(REQUESTED_KEYS.map((key) => [key, null])),
    unanswered: [],
  },
  'rest:workspace:token.list': { tokens: [], truncated: false },
  'rest:workspace:serving-endpoints': { endpoints: [], truncated: false },
  'rest:workspace:vector-search.endpoints': { endpoints: [], truncated: false },
};

/**
 * Controls whose evidence is a setting rather than a population.
 *
 * These are exempt from the rule below, and the exemption is the point rather than a
 * concession. The rule exists because a ratio over an empty population is meaningless:
 * zero over-partitioned tables out of zero tables says nothing about anyone's estate. A
 * setting has no population. The workspace exists, the endpoint answered, and the answer
 * was that nothing has ever been configured — so "enforcement is not enabled" is a
 * measurement, and reporting it as unmeasured would be the fabrication in this direction.
 *
 * Derived from the settings table rather than listed, so a key that changes what an unset
 * value means moves in and out of this set without anyone remembering to edit it. The
 * `unknown` keys stay subject to the rule, which is what their declaration means.
 */
const CONFIGURED_ABSENCE = new Set<string>([
  ...SETTING_KEYS.filter((setting) => setting.whenAbsent !== 'unknown').map((setting) => setting.controlId),
  // The token lifetime maximum, whose absence means unlimited. Not in the table above
  // because it is a number rather than a flag.
  'SCP-01-04',
]);

/**
 * Controls whose evidence is that the query resolved, not what it returned.
 *
 * A second exemption with a different reason, kept separate so neither can be widened by
 * appealing to the other. `system.information_schema` is a Unity Catalog view: it cannot answer
 * for a workspace with no metastore assignment, so a census in hand — even a census of nothing —
 * is the assignment observed. The empty fixture here is a real estate rather than a degenerate
 * one: a metastore assigned and not yet used.
 *
 * The absent case is still covered by the rule, and covered where it belongs. A workspace with
 * no assignment produces an unavailable signal rather than an empty one, and metastore.test.ts
 * asserts both of these report unmeasurable when that happens.
 */
const PREMISE_OF_THE_QUERY = new Set<string>(['SCP-04-10', 'SCP-04-14']);

/** Both exemptions, since the rule is one rule with two stated carve-outs. */
const EXEMPT = new Set<string>([...CONFIGURED_ABSENCE, ...PREMISE_OF_THE_QUERY]);

/**
 * What a collector would hand a resolver for this signal on an empty estate.
 *
 * Not always a value: a signal may declare that no rows means no answer, in which case
 * the collector reports it unmeasurable and the resolver never sees zeroes at all.
 * Reproducing that here rather than always fabricating an observed value is the
 * difference between testing the app and testing a fixture.
 */
function emptySignal(signal: SignalId): SignalResult {
  const assembled = ASSEMBLED[signal];
  return assembled != null ? observed(signal, assembled, 0) : emptySqlSignal(signal)!;
}

/**
 * Outcomes that put a control into the score.
 *
 * `satisfied-by-architecture` is in this list because it credits a pass. An estate that
 * ran nothing at all has not earned architectural credit — "you have no classic clusters,
 * so serverless is autoscaling for you" is only true if something was running.
 */
const SCORED: readonly Outcome[] = ['pass', 'partial', 'fail', 'satisfied-by-architecture'];

const resolved = catalogue.controls.filter((control) => registry.get(control.id) != null);

function findingOnAnEmptyEstate(controlId: string, override: ReadonlyMap<SignalId, SignalResult> = new Map()) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);

  const resolver = registry.get(controlId);
  // Preconditions as well as requirements: applicability runs first and is most of the
  // answer here, so a fixture that omitted the precondition signals would test the
  // resolvers against an applicability step that never ran.
  const needed = [
    ...(resolver?.requires ?? []),
    ...(resolver?.enrichedBy ?? []),
    ...(spec.preconditions ?? []).map((precondition) => precondition.signal),
  ];

  const signals = new Map<SignalId, SignalResult>();
  for (const signal of needed) signals.set(signal, override.get(signal) ?? emptySignal(signal));

  return resolveControl(spec, signals, resolver);
}

describe('an estate with nothing in it', () => {
  it('has an empty result for every signal a resolver reads', () => {
    // A signal with no empty result arrives as undefined, and a resolver reading a field
    // off undefined throws — which this suite would report as a fault in the resolver
    // rather than in its own fixture.
    const read = resolved.flatMap((control) => registry.get(control.id)?.requires ?? []);
    const missing = [...new Set(read)].filter(
      (signal) => ASSEMBLED[signal] == null && emptySqlSignal(signal) == null
    );
    expect(missing, `no empty result defined for: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(resolved.filter((control) => !EXEMPT.has(control.id)).map((control) => control.id))(
    'scores nothing for %s',
    (controlId) => {
      const finding = findingOnAnEmptyEstate(controlId);
      expect(
        SCORED.includes(finding.outcome) ? finding.outcome : 'unscored',
        `${controlId} reached ${finding.outcome} from no evidence: ${finding.outcomeReason ?? 'no reason given'}`
      ).toBe('unscored');
    }
  );

  it.each([...CONFIGURED_ABSENCE])('scores %s from an unconfigured workspace, and says why', (controlId) => {
    // The other side of the exemption. Without this the exempt controls would be free to
    // return anything at all, including the unmeasurable this suite was written to prevent.
    const finding = findingOnAnEmptyEstate(controlId);
    expect(finding.outcome, `${controlId}: ${finding.outcomeReason ?? 'no reason given'}`).toBe('fail');
    expect(finding.evidence[0]?.observed ?? '', controlId).toMatch(/never been set|no maximum/i);
  });

  it('says why it declined, for every control', () => {
    // Unmeasurable with no reason is the worst of both: the control is absent from the
    // score and the user is told nothing about how to change that.
    const silent = resolved
      .map((control) => findingOnAnEmptyEstate(control.id))
      .filter((finding) => (finding.outcomeReason ?? '').length < 40)
      .map((finding) => `${finding.controlId} (${finding.outcome})`);
    expect(silent, `declined without a usable reason: ${silent.join(', ')}`).toEqual([]);
  });
});

/**
 * The estate that only looks empty.
 *
 * The suite above hands every resolver a census of zeroes and holds them to reaching no score
 * from it. Which of the two unscored outcomes they reach is the whole of row 40b, and nothing
 * above distinguishes them: `not-applicable` says the estate has no tables, `unmeasurable` says
 * this identity could not see them, and only one of those is true of a principal holding nothing
 * on the customer's catalogs.
 *
 * Driven through `resolveControl` rather than through the helper, because the defect was never in
 * the helper. It was in fourteen call sites, and a helper with four tests beside fourteen callers
 * that may or may not consult it is the shape the first version of this had.
 */
const ONLY_LOOKS_EMPTY: readonly string[] = [
  'DG-01-02',
  'DG-01-03',
  'DG-01-04',
  'DG-01-05',
  'IU-04-01',
  'IU-04-02',
  'IU-04-03',
  'OE-01-06',
  'OE-02-03',
  'PE-03-06',
  'CO-01-01',
  'REL-01-01',
  'DG-03-03',
  'IU-02-01',
];

const LINEAGE = 'sql:uc.lineage_coverage' as SignalId;

/** What the labs probe read: no catalogue at all, beside lineage over tables it cannot list. */
const CONTRADICTED = new Map<SignalId, SignalResult>([
  [
    LINEAGE,
    observed(
      LINEAGE,
      {
        tableCount: 0,
        tablesWithLineage: 26,
        tablesWrittenWithLineage: 18,
        tablesReadWithLineage: 24,
        lineageEvents: 3850,
      },
      1
    ),
  ],
]);

describe('an estate that only looks empty', () => {
  it.each(ONLY_LOOKS_EMPTY)('%s is unmeasured rather than excluded, and says how to fix it', (controlId) => {
    const finding = findingOnAnEmptyEstate(controlId, CONTRADICTED);

    expect(finding.outcome, `${controlId}: ${finding.outcomeReason ?? 'no reason given'}`).toBe('unmeasurable');
    expect(finding.remedy?.says ?? '', controlId).toContain('BROWSE');
  });

  it.each(ONLY_LOOKS_EMPTY)('%s is excluded when the same reading corroborates the emptiness', (controlId) => {
    // The other half, and the one that keeps the fix from being "report everything unmeasured".
    // A workspace whose metastore is genuinely empty records no lineage over it either, and its
    // requirements have to be able to leave the score.
    const finding = findingOnAnEmptyEstate(controlId);

    expect(finding.outcome, `${controlId}: ${finding.outcomeReason ?? 'no reason given'}`).toBe('not-applicable');
  });
});
