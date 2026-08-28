// The bump computes the fingerprinted projection and this app displays it, and nothing else holds the
// two together.
//
// The risk is the same shape as the changelog's and worse in one respect. `catalogue-version.mjs` has
// to run without the server build — it is a guard the repository depends on, so it cannot import a
// compiled bundle — which means the projection it fingerprints and the projection this app compares
// against are two pieces of code in two languages that agree by convention about a field list.
//
// What happens when they stop agreeing is not a crash. `driftBetween` would report the disagreement
// as drift, on every requirement at once, and the methodology page would tell every customer that
// their shipped config has been edited behind the app's back. That is a false accusation of tampering
// produced by a refactor, and no test that reads a hand-written fixture would catch it.
//
// So this drives the real script over a real catalogue and reads the result back through the real
// loader, then asserts the one thing that has to hold: a catalogue the bump has just recorded is a
// catalogue this app finds no drift in.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalogue } from './catalogue.js';
import { driftBetween } from './methodology.js';
import { liveShapesFor } from '../api/methodology-routes.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'catalogue-version.mjs');

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * A catalogue exercising every field the fingerprint covers.
 *
 * Every one of them, deliberately: a field present in the projection and absent from this fixture is a
 * field whose two implementations could disagree without this test noticing, which is the whole failure
 * it exists to catch. Two pillars because `pillar` is in the projection and a single-pillar fixture
 * cannot tell a pillar code from a constant.
 */
function catalogueDirectory(options: { readonly severity?: string; readonly clouds?: string } = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'waf-methodology-'));
  directories.push(directory);
  writePillars(directory, options);
  execFileSync('node', [SCRIPT, '--dir', directory], { encoding: 'utf8' });
  return directory;
}

function writePillars(directory: string, options: { readonly severity?: string; readonly clouds?: string }): void {
  writeFileSync(
    join(directory, 'reliability.yaml'),
    [
      'pillar:',
      '  code: reliability',
      '  name: Reliability',
      'principles:',
      '  - id: rel-1',
      '    name: One',
      '    controls:',
      '      - id: REL-01-01',
      '        title: Keep two of everything',
      `        severity: ${options.severity ?? 'high'}`,
      '        provenance: waf-docs',
      '        measurability: system-table',
      '        evaluator_status: implemented',
      '        coverage_mode: sampled',
      '        alias_group: redundancy',
      '        clouds:',
      `${options.clouds ?? '          - aws\n          - azure'}`,
      '        thresholds:',
      '          pass_share: 0.95',
      '          partial_share: 0.7',
      '        applicability:',
      '          preconditions:',
      '            - signal: sql:estate.compute_profile',
      '              operator: eq',
      '              value: 0',
      '              outcome: not-applicable',
      '              scope: estate',
      '              reason: There is no all-purpose compute here.',
      '      - id: REL-01-02',
      '        title: Recover from a region loss',
      '        severity: critical',
      '        provenance: security-guide',
      '        measurability: attestation',
      '        evaluator_status: implemented',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(directory, 'cost-optimization.yaml'),
    [
      'pillar:',
      '  code: cost-optimization',
      '  name: Cost optimization',
      'principles:',
      '  - id: co-1',
      '    name: One',
      '    controls:',
      '      - id: CO-01-01',
      '        title: Keep two of everything',
      '        severity: high',
      '        provenance: waf-docs',
      '        measurability: system-table',
      '        evaluator_status: implemented',
      '        alias_group: redundancy',
      '',
    ].join('\n'),
  );
}

describe('the projection the bump fingerprints is the projection this app compares against', () => {
  it('finds no drift in a catalogue the bump has just recorded', () => {
    const catalogue = loadCatalogue(catalogueDirectory());

    // The assertion the whole file exists for. Any disagreement about a field name, a default, or how
    // an absent value is written down surfaces here, and surfaces before it reaches a customer as an
    // accusation that they edited their config.
    expect(driftBetween(catalogue.recorded, liveShapesFor(catalogue))).toEqual({
      changed: [],
      missing: [],
      unrecorded: [],
    });
  });

  it('records every requirement, with the fields that decide how it scores', () => {
    const catalogue = loadCatalogue(catalogueDirectory());

    expect([...catalogue.recorded.shapes.keys()].sort()).toEqual(['CO-01-01', 'REL-01-01', 'REL-01-02']);
    expect(catalogue.recorded.shapes.get('REL-01-01')).toEqual({
      id: 'REL-01-01',
      pillar: 'reliability',
      principle: 'rel-1',
      title: 'Keep two of everything',
      provenance: 'waf-docs',
      severity: 'high',
      measurability: 'system-table',
      coverage_mode: 'sampled',
      alias_group: 'redundancy',
      clouds: ['aws', 'azure'],
      thresholds: { pass_share: 0.95, partial_share: 0.7 },
      preconditions: [
        { signal: 'sql:estate.compute_profile', operator: 'eq', value: 0, outcome: 'not-applicable', scope: 'estate' },
      ],
    });
  });

  it('counts what a score is out of, with an alias group scored once', () => {
    // Three requirements, two of them the same requirement seen from two pillars.
    expect(loadCatalogue(catalogueDirectory()).recorded.scoredUnits).toBe(2);
  });

  it('names the field when the shipped config is edited without a bump', () => {
    const directory = catalogueDirectory();
    // What a hand-edited install looks like: the YAML moves, `version.json` does not.
    writePillars(directory, { severity: 'low' });

    const catalogue = loadCatalogue(directory);
    const drift = driftBetween(catalogue.recorded, liveShapesFor(catalogue));

    expect(drift.changed).toEqual([{ id: 'REL-01-01', fields: ['severity'] }]);
    // Unchanged, because the record still holds them and the catalogue still has them. A drift check
    // that reported the whole catalogue over one edited field would be read as noise and ignored.
    expect(drift.missing).toEqual([]);
    expect(drift.unrecorded).toEqual([]);
  });

  it('finds no drift when only the order of a list moved', () => {
    const directory = catalogueDirectory();
    writePillars(directory, { clouds: '          - azure\n          - aws' });

    const catalogue = loadCatalogue(directory);

    // `clouds` is a set of the clouds a requirement applies to. Reordering it changes nothing about
    // what is asked, and reporting it would train the reader to dismiss the drift notice.
    expect(driftBetween(catalogue.recorded, liveShapesFor(catalogue)).changed).toEqual([]);
  });

  it('separates a requirement the record has from one the catalogue has', () => {
    const directory = catalogueDirectory();
    writeFileSync(
      join(directory, 'cost-optimization.yaml'),
      [
        'pillar:',
        '  code: cost-optimization',
        '  name: Cost optimization',
        'principles:',
        '  - id: co-1',
        '    name: One',
        '    controls:',
        '      - id: CO-01-09',
        '        title: Something else entirely',
        '        severity: high',
        '        provenance: waf-docs',
        '        measurability: system-table',
        '        evaluator_status: implemented',
        '',
      ].join('\n'),
    );

    const catalogue = loadCatalogue(directory);
    const drift = driftBetween(catalogue.recorded, liveShapesFor(catalogue));

    // Two facts, not one change. A requirement the app is scoring that no version records is a
    // different problem from a recorded requirement the app has stopped asking about, and folding
    // them into `changed` would report the second as an edit to the first.
    expect(drift.missing).toEqual(['CO-01-01']);
    expect(drift.unrecorded).toEqual(['CO-01-09']);
  });
});
