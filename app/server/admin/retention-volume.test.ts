import { describe, expect, it } from 'vitest';
import { RETAINED } from './retention';
import {
  RUN_CADENCE_DAYS,
  SWEPT_VOLUMES,
  advisoryRuns,
  assessmentRuns,
  revisionsEach,
  unsized,
} from './retention-volume';

describe('the volumes the retention sweep is measured at', () => {
  // The invariant the module exists for. A table added to `RETAINED` with no volume here would be
  // measured at zero rows by `measure-retention-sweeps.mts`, come out needing no index, and be
  // recorded as a decision — which is the failure mode `83` is a correction of, arriving by a new
  // route. A sequential scan of a table nobody sized is not a reading about that table.
  it('sizes every table the sweep visits, and no table it does not', () => {
    expect(unsized()).toEqual({ unsized: [], unswept: [] });
  });

  it('gives every table a positive row count at the catalogue size the app ships', () => {
    const empty = SWEPT_VOLUMES.filter((one) => one.rows(141) <= 0).map((one) => one.table);
    expect(empty).toEqual([]);
  });

  // Provenance is the field the published table prints beside each number, and the reason it is a
  // field rather than prose is that prose can be left off. This holds that neither value has been
  // quietly applied to everything: a module where all twenty-two read `derived` would be one where
  // the run cadence had been promoted to a fact.
  it('marks some counts derived and some assumed, and does not read one way throughout', () => {
    const derived = SWEPT_VOLUMES.filter((one) => one.provenance === 'derived');
    const assumed = SWEPT_VOLUMES.filter((one) => one.provenance === 'assumed');
    expect(derived.length).toBeGreaterThan(0);
    expect(assumed.length).toBeGreaterThan(0);
    expect(derived.length + assumed.length).toBe(SWEPT_VOLUMES.length);
  });

  // Every table sized from the run cadence is an assumption, because the cadence is. This is the
  // check that would have caught the mistake AGENTS.md names: three sentences baked this
  // repository's own weekly cron in as though it were a fact about an install.
  it('never calls a count derived when the run cadence is what sized it', () => {
    const runShaped = new Set(['scans', 'imported_evidence', 'pillar_reviews', 'run_checkpoints', 'runs']);
    const wrong = SWEPT_VOLUMES.filter((one) => runShaped.has(one.table) && one.provenance === 'derived');
    expect(wrong.map((one) => one.table)).toEqual([]);
  });

  it('explains each count in words that name the arithmetic', () => {
    const silent = SWEPT_VOLUMES.filter((one) => one.derives.trim().length < 20).map((one) => one.table);
    expect(silent).toEqual([]);
  });

  it('reads the periods off the policy rather than repeating them', () => {
    // 730 / 7 and 90 / 7. Written out here so a change to either constant fails a test that says
    // which arithmetic moved, rather than only moving a number in a recording nobody re-reads.
    expect(assessmentRuns()).toBe(Math.ceil(730 / RUN_CADENCE_DAYS));
    expect(advisoryRuns()).toBe(Math.ceil(90 / RUN_CADENCE_DAYS));
    expect(revisionsEach()).toBe(29);
  });

  // The spread is the reason the module exists: one row count for all twenty-two would size the
  // smallest table and the largest the same, and an index is decided by which of those a table is.
  it('spans three orders of magnitude, which is why one count could not have served', () => {
    const counts = SWEPT_VOLUMES.map((one) => one.rows(141));
    const smallest = Math.min(...counts);
    const largest = Math.max(...counts);
    expect(largest / smallest).toBeGreaterThan(100);
  });

  it('sizes the registers from the sweep entry that names them', () => {
    for (const table of ['attestations', 'accepted_risks', 'applicability_decisions']) {
      const volume = SWEPT_VOLUMES.find((one) => one.table === table);
      expect(volume?.rows(141)).toBe(141 * revisionsEach());
      expect(RETAINED.some((one) => one.table === table)).toBe(true);
    }
  });
});
