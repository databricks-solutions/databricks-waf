// A row for every table the retention sweep visits, at the width the app writes one.
//
// `history-fixtures.ts` builds records for the eight tables the history reads draw from, through the
// domain's own types, and `history-fixtures.test.ts` fails when one is narrower than its interface.
// That is the right apparatus for that measurement, and it is the wrong one for this: `83` measures
// twenty-two tables, half of which hold no record any interface in this app declares — a checkpoint
// is a reading, an audit event is a link in a chain, a publication is frozen bytes.
//
// So these are built to the *schema* rather than to a type, and what the measurement needs from them
// is narrower than what a history read needs. Every statement the sweep sends is a `count`, an
// `order by … limit 1` or a `delete`, and not one of them selects a body. What decides their cost is
// how many heap pages the table occupies, which is decided by the row's width up to the point TOAST
// moves the wide columns out of line — and past that point a wider body costs the count nothing.
//
// That is why the widths below matter and why they stop mattering above two kilobytes. A fixture with
// `body` set to `{}` would pack far more rows per page than the app does and would report a
// sequential scan as cheap, which is H1's fixture mistake in the direction that declines an index.
// A fixture with a megabyte body would report the same page count as one with three kilobytes,
// because both are out of line. The widths are the app's, taken from what these records hold, and the
// published table says the count statements never read them.

import { randomUUID } from 'node:crypto';
import { advisoryRuns, assessmentRuns } from '../admin/retention-volume.js';

/** Words rather than a repeated character, because TOAST compresses one and not the other. */
function prose(length: number, seed: number): string {
  const words = [
    'the',
    'requirement',
    'is',
    'answered',
    'by',
    'a',
    'quarterly',
    'review',
    'that',
    'platform',
    'engineering',
    'runs',
    'against',
    'the',
    'production',
    'workspaces',
    'and',
    'records',
    'in',
    'confluence',
    'with',
    'the',
    'run',
    'attached',
  ];
  let text = '';
  let index = seed;
  while (text.length < length) {
    text += `${words[index % words.length] ?? 'and'} `;
    index += 1;
  }
  return text.slice(0, length).trim();
}

function owner(seed: number): string {
  return `${['priya.raman', 'j.okonkwo', 'data-platform-oncall', 'm.svensson', 'governance-council'][seed % 5] ?? 'owner'}@example.com`;
}

/** A body of a stated width, shaped like a record rather than one long string. */
function body(bytes: number, seed: number): string {
  return JSON.stringify({
    id: randomUUID(),
    recordedBy: owner(seed),
    summary: prose(Math.min(bytes, 240), seed),
    detail: prose(Math.max(0, bytes - 300), seed + 7),
    references: [`https://example.atlassian.net/wiki/spaces/PLATFORM/pages/${String(490_000 + seed)}`],
  });
}

/** A digest-shaped hex string, at the width `digestOf` produces. */
function digest(seed: number): string {
  return `${(seed * 2_654_435_761).toString(16).padStart(16, '0')}`.repeat(4).slice(0, 64);
}

/**
 * How many runs the fixture seeds, which two other tables have to agree with.
 *
 * `run_attempts` is swept by a subquery on `runs.kind`, so its rows have to name run ids that exist
 * and carry the kind the sweep selects. A fixture where they did not would measure a semi-join that
 * matches nothing — fast, reproducible, and about no sweep this app runs.
 */
const RUNS = assessmentRuns() + advisoryRuns();

/** One run in every `ADVISORY_EVERY` is an advisory one, which puts the two kinds across the period. */
const ADVISORY_EVERY = Math.max(2, Math.round(RUNS / advisoryRuns()));

/**
 * The instant every stamp below is measured back from, fixed once for the process.
 *
 * `Date.now()` per row would have been the obvious thing and is wrong for a reason the seeding makes
 * unavoidable: filling twenty-two tables takes minutes, so the last row's "now" is minutes after the
 * first's, and the boundary between eligible and not stops being a line. The measurement then reports
 * a tenth of a table as eligible in one run and a tenth plus a handful in the next, which is drift a
 * reader would read as noise in the database.
 *
 * Exported because the cutoffs are computed elsewhere. A cutoff taken from a later `Date.now()` than
 * the stamps were is the same bug one layer up, and it is the one the fixture test caught.
 */
export const ORIGIN = new Date();

/**
 * The stamp for row `index` of `total`, spread evenly across `days` back from `ORIGIN`.
 *
 * Even rather than clustered, and that is what makes the two cutoffs in the measurement mean what
 * they are named: the boundary catches nothing and a tenth of the way in catches a tenth. A real
 * install's rows are not evenly spread, and the published table says the fraction rather than
 * claiming the distribution.
 */
function stampFor(index: number, total: number, days: number): Date {
  const share = total <= 1 ? 0 : index / total;
  return new Date(ORIGIN.getTime() - days * (1 - share) * 24 * 60 * 60 * 1000);
}

/**
 * People who leave a half-written assessment.
 *
 * Only the author count is fixed. The assessment side of the key runs on rather than wrapping, so
 * the key space is open — the first version of this wrapped both at `index % 8` and `index % 12`,
 * which gave ninety-six distinct pairs for a volume of ninety-six and then silently seeded two
 * thirds of a table the moment anything asked for more. `on conflict do nothing` makes that kind of
 * shortfall invisible, and a page count published for a table a third the size it claims is a
 * reading about no install.
 */
const DRAFT_AUTHORS = 8;

type Row = Readonly<Record<string, unknown>>;

/**
 * A row for one swept table, at `index` of `total`, stamped inside a `days`-long period.
 *
 * One function with a switch rather than a builder per table, because every branch is the same three
 * lines — the key, the stamp, and a body of a stated width — and twenty-two exported functions would
 * be twenty-two places to forget the stamp. The switch is exhaustive against `RETAINED` by
 * `retention-fixtures.test.ts`, which is what a missing branch would otherwise cost: a table seeded
 * with nothing and measured as needing no index.
 */
export function rowFor(table: string, index: number, total: number, days: number): Row {
  const at = stampFor(index, total, days);
  const id = `${table}-${String(index)}`;
  const seed = index;

  switch (table) {
    case 'assessment_setup_drafts':
      // Keyed on the pair, so the two have to vary independently: `owner` cycles over five names and
      // would have given sixty distinct drafts for a volume of ninety-six, seeding the table two
      // thirds full with `on conflict do nothing` reporting nothing.
      return {
        author: `author-${String(index % DRAFT_AUTHORS)}@example.com`,
        definition_id: `assessment-${String(Math.floor(index / DRAFT_AUTHORS))}`,
        saved_at: at,
        body: body(2_000, seed),
      };
    case 'scans':
      // The widest body in the schema: a whole scan, every finding and every reading behind it.
      return { id, started_at: at, summary: body(4_000, seed), body: body(400_000, seed) };
    case 'imported_evidence':
      return {
        digest: digest(index),
        generated_at: at,
        imported_at: at,
        imported_by: owner(index),
        body: body(200_000, seed),
        cautions: body(800, seed),
      };
    case 'attestations':
      return { id, control_id: controlId(index), attested_at: at, body: body(1_200, seed) };
    case 'decisions':
      return { id, control_id: controlId(index), decided_at: at, body: body(1_200, seed) };
    case 'improvement_plans':
      return {
        id,
        revision: 0,
        created_at: at,
        changed_at: at,
        body: body(1_000, seed),
        digest: digest(index),
        definition_id: `assessment-${String(index % 12)}`,
      };
    case 'improvement_actions':
      return {
        id,
        revision: 0,
        plan_id: `improvement_plans-${String(index % 12)}`,
        plan_created_at: at,
        created_at: at,
        changed_at: at,
        body: body(2_000, seed),
        digest: digest(index),
      };
    case 'validation_attempts':
      return {
        id,
        revision: 0,
        action_id: `improvement_actions-${String(index)}`,
        plan_id: `improvement_plans-${String(index % 12)}`,
        plan_created_at: at,
        requested_at: at,
        answered: index % 3 !== 0,
        body: body(1_500, seed),
        digest: digest(index),
      };
    case 'accepted_risks':
      return {
        id,
        revision: 0,
        control_id: controlId(index),
        ordinal: index,
        owner: owner(index),
        residual: ['low', 'medium', 'high'][index % 3] ?? 'low',
        effective_from: at,
        expires_at: at,
        recorded_at: at,
        revoked: false,
        body: body(1_200, seed),
        digest: digest(index),
        definition_id: `assessment-${String(index % 12)}`,
      };
    case 'applicability_decisions':
      return {
        id,
        revision: 0,
        control_id: controlId(index),
        lever: ['not-applicable', 'compensating', 'deferred'][index % 3] ?? 'deferred',
        ordinal: index,
        owner: owner(index),
        effective_from: at,
        expires_at: at,
        recorded_at: at,
        revoked: false,
        body: body(1_200, seed),
        digest: digest(index),
        definition_id: `assessment-${String(index % 12)}`,
      };
    case 'notes':
      return {
        id,
        subject_kind: 'control',
        subject_id: controlId(index),
        noted_at: at,
        body: body(600, seed),
        digest: digest(index),
      };
    case 'pillar_reviews':
      return {
        id,
        review_id: `assessment_reviews-${String(Math.floor(index / 7))}`,
        pillar_id: pillarId(index),
        recorded_at: at,
        body: body(500, seed),
        digest: digest(index),
      };
    case 'review_answers':
      return {
        id,
        review_id: `assessment_reviews-${String(index % Math.max(1, assessmentRuns()))}`,
        pillar_id: pillarId(index),
        attestation_id: `attestations-${String(index)}`,
        recorded_at: at,
        body: body(500, seed),
        digest: digest(index),
      };
    case 'assessment_results':
      return {
        id,
        review_id: `assessment_reviews-${String(index)}`,
        finalised_at: at,
        body: body(20_000, seed),
        digest: digest(index),
      };
    case 'assessment_reviews':
      return { id, run_id: `runs-${String(index)}`, opened_at: at, body: body(1_000, seed), digest: digest(index) };
    case 'month_publications':
      // `json` and `csv` are text rather than jsonb, frozen at publish and served back verbatim.
      return {
        id,
        month: `20${String(19 + Math.floor(index / 12)).padStart(2, '0')}-${String((index % 12) + 1).padStart(2, '0')}`,
        published_at: at,
        published_by: owner(index),
        document_version: 1,
        digest: digest(index),
        json: body(50_000, seed),
        csv: prose(30_000, seed),
        ordinal: index,
      };
    case 'run_attempts':
      return {
        id,
        run_id: `runs-${String(index % RUNS)}`,
        number: (index % 2) + 1,
        holder: owner(index),
        started_at: at,
        heartbeat_at: at,
        ended_at: at,
        outcome: index % 5 === 0 ? 'abandoned' : 'finished',
      };
    case 'plan_extracts':
      return {
        workspace_id: `ws-${String(index % 3)}`,
        shape: `shape-${String(index % 40)}`,
        statement_id: `statement-${String(index)}`,
        advisory_id: `advisories-${String(index % Math.max(1, advisoryRuns()))}`,
        advisory_at: at,
        observed_at: at,
        shape_version: '3',
        extract: body(8_000, seed),
      };
    case 'advisories':
      return {
        id,
        run_id: `runs-${String(index)}`,
        started_at: at,
        finished_at: at,
        state: 'complete',
        scope: 'workspace',
        lookback_days: 30,
        definition_id: `assessment-${String(index % 12)}`,
        considered: 400,
        body: body(100_000, seed),
      };
    case 'runs':
      return {
        id,
        requested_at: at,
        actor: owner(index),
        trigger: index % ADVISORY_EVERY === 0 ? 'schedule' : 'manual',
        request: body(500, seed),
        state: 'finished',
        attempts: 1,
        lease_until: at,
        finished_at: at,
        kind: index % ADVISORY_EVERY === 0 ? 'advisory' : 'assessment',
      };
    case 'run_checkpoints':
      return {
        run_id: `runs-${String(index % RUNS)}`,
        signal_id: `signal-${String(index)}`,
        at,
        reading: body(2_000, seed),
      };
    case 'audit_events':
      // `sequence` is contiguous and the chain is by digest, both of which the trim depends on: it
      // finds the first event that must be kept and removes the prefix below it.
      return {
        sequence: index + 1,
        id,
        at,
        actor: owner(index),
        action: ['attest', 'accept', 'publish', 'sweep', 'scan'][index % 5] ?? 'attest',
        outcome: 'performed',
        target_id: controlId(index),
        correlation: `run-${String(index % RUNS)}`,
        previous: digest(index),
        digest: digest(index + 1),
        body: body(400, seed),
      };
    default:
      throw new Error(
        `No fixture for ${table}, so the retention measurement would seed it with nothing and report ` +
          'that it needs no index. Add a branch to rowFor.'
      );
  }
}

function controlId(index: number): string {
  const pillars = ['SEC', 'REL', 'COST', 'OPS', 'PERF', 'GOV', 'AI'];
  const pillar = pillars[index % pillars.length] ?? 'SEC';
  return `${pillar}-${String(Math.floor(index / pillars.length) + 1).padStart(3, '0')}-${['access', 'encryption', 'lineage', 'quota', 'backup'][index % 5] ?? 'control'}`;
}

function pillarId(index: number): string {
  return (
    ['security', 'reliability', 'cost-optimisation', 'operational-excellence', 'performance', 'governance', 'ai'][
      index % 7
    ] ?? 'security'
  );
}
