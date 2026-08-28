// Loading the catalogue, including from where the shipped bundle sits.
//
// The path test exists because of a real failure: the bundler flattens this module from
// `server/catalogue/` to `dist/catalogue/`, so a path built from a fixed number of `..`
// segments resolved to `dist/config/controls` in the deployed app and to the right place
// in development. It booted perfectly on a developer machine and died on install with an
// ENOENT naming a directory nobody had written. Nothing about that is visible in a test
// that only ever loads from source.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTING_KEYS } from '../collect/rest/settings-keys.js';
import { catalogueDirectory, loadCatalogue } from './catalogue.js';

const APP_ROOT = join(import.meta.dirname, '..', '..');

describe('finding the catalogue', () => {
  it('resolves from source, where this module lives two levels below the app root', () => {
    expect(catalogueDirectory()).toBe(join(APP_ROOT, 'config', 'controls'));
  });

  it('resolves from the bundle, where it lives one level below', () => {
    const asBundled = pathToFileURL(join(APP_ROOT, 'dist', 'catalogue', 'catalogue.js')).href;

    expect(catalogueDirectory(asBundled)).toBe(join(APP_ROOT, 'config', 'controls'));
  });

  it('says the tree is incomplete rather than reporting an unhelpful ENOENT', () => {
    const outside = pathToFileURL(join('/', 'tmp', 'nowhere', 'catalogue.js')).href;

    expect(() => catalogueDirectory(outside)).toThrow(/config\/controls directory found/);
  });
});

describe('the loaded catalogue', () => {
  const catalogue = loadCatalogue();

  it('carries every pillar with its controls', () => {
    expect(catalogue.pillars.length).toBeGreaterThan(0);
    expect(catalogue.controls.length).toBeGreaterThan(100);
  });

  it('gives every control an id, a pillar and a provenance', () => {
    const incomplete = catalogue.controls.filter(
      (control) => control.id === '' || control.pillarId === '' || control.provenance == null
    );

    expect(incomplete).toEqual([]);
  });

  it('groups cross-pillar aliases so scoring can count them once', () => {
    for (const [group, controls] of catalogue.aliasGroups) {
      expect(controls.length, `alias group ${group} has one member, so it is not an alias`).toBeGreaterThan(1);
    }
  });

  /*
   * The 15 controls this covers were all found the same way: by exporting a real assessment to a
   * spreadsheet and filtering to the failures with an empty next-step column. Every one of them was
   * an alias — the same requirement stated in a second pillar — whose group already carried a fix.
   */
  it('gives every requirement it can measure a fix, sharing one across an alias group', () => {
    const measured = catalogue.controls.filter((control) => control.evaluatorStatus === 'implemented');
    const unactionable = measured.filter((control) => control.remediation?.summary == null).map((one) => one.id);

    expect(unactionable, 'a requirement this app can fail has to say what to do about it').toEqual([]);
  });

  it('leaves no member of an alias group without a fix, whichever member authored it', () => {
    const orphans = [...catalogue.aliasGroups]
      .filter(([, controls]) => controls.some((one) => one.remediation != null))
      .flatMap(([group, controls]) =>
        controls.filter((one) => one.remediation == null).map((one) => `${group}/${one.id}`)
      );

    expect(orphans).toEqual([]);
  });

  it('lets two pillars keep different fixes where they genuinely want different things', () => {
    /*
     * Delta history retention is the case the inheritance rule must not flatten: cost optimization
     * asks for the window to be shortened, reliability asks for it to be long enough to recover
     * from, and both are true. Copying one over the other would have a cost finding telling a
     * reader to lengthen retention to save money.
     */
    const [cost, reliability] = ['CO-03-07', 'REL-04-05'].map((id) =>
      catalogue.controls.find((control) => control.id === id)
    );

    expect(cost?.aliasGroup).toBe(reliability?.aliasGroup);
    expect(cost?.remediation?.summary).not.toBe(reliability?.remediation?.summary);
    expect(cost?.remediation?.caveat).toContain('reduces both storage cost');
    expect(reliability?.remediation?.caveat).toContain('cost pillar wants shortened');
  });

  /*
   * The workspace settings are the one family where the fix and the measurement are the same fact
   * written twice: the resolver reads `enableDbfsFileBrowser` and the fix sets it. Two hand-authored
   * copies of a key like that agree until somebody corrects the spelling on one side, and the
   * failure is silent and specific — the reader runs a command that changes nothing, the next run
   * reports the identical finding, and the app is the thing that looks wrong.
   */
  it('gives each workspace-setting requirement a fix that sets the key its resolver reads', () => {
    const wrong = SETTING_KEYS.filter((setting) => {
      const cli = catalogue.controls.find((control) => control.id === setting.controlId)?.remediation?.cli;
      return cli == null || !cli.includes(`"${setting.key}": "${setting.secure}"`);
    }).map((setting) => `${setting.controlId} should set ${setting.key} to ${setting.secure}`);

    expect(wrong).toEqual([]);
  });

  /**
   * A question that never said what it was standing in for outlives the reason it was asked.
   *
   * The failure is silent and slow, which is why this is pinned in the fast test run rather than left
   * to the ledger check alone: a system table ships, a column is added to one that already existed,
   * and nothing prompts anybody to revisit a question, because the question recorded only that it was
   * a question. `enrich-catalogue.mjs` refuses first and the ledger refuses on the generated
   * catalogue; this fails in `npm test`, where the person who added the question is still looking.
   */
  it('makes every question say what a machine would have to observe instead', () => {
    const silent = catalogue.controls
      .filter((control) => control.measurability === 'attestation')
      .filter((control) => control.attestation?.askedBecause == null)
      .map((control) => control.id);

    expect(silent).toEqual([]);
  });

  /**
   * The verdict that reads as a debt has to keep reading as one.
   *
   * `owed-a-measure` means the platform records enough and this app does not read it yet, and its
   * whole value is that the ledger publishes the count. A signal named beside it is what makes the
   * claim checkable — and what makes converting it a defined piece of work rather than a research
   * task — so an entry claiming evidence exists without naming it is the one shape to refuse.
   */
  it('makes a question that claims evidence exists name it', () => {
    const vague = catalogue.controls
      .filter((control) => control.attestation?.askedBecause != null)
      .filter((control) => control.attestation?.askedBecause?.verdict !== 'beyond-telemetry')
      .filter((control) => (control.attestation?.askedBecause?.signal ?? '') === '')
      .map((control) => control.id);

    expect(vague).toEqual([]);
  });

  it('leaves a requirement with its own fix alone', () => {
    // Inheritance fills gaps; it does not overwrite. CO-01-01 authored the conversion snippet its
    // group now shares, and it has to still be the one carrying it.
    const authored = catalogue.controls.find((control) => control.id === 'CO-01-01');

    expect(authored?.remediation?.sql).toContain('CONVERT TO DELTA');
  });
});

// The version reached live scans as `0.0.0` while the fingerprint beside it was
// correct, because the bump script writes a JSON number and the reader accepted only
// a string. Nothing failed: the catalogue loaded, the scan ran, the score was right,
// and the one field that tells a user which questions were asked was wrong. These
// read the real file rather than a fixture, because a fixture would have agreed with
// whatever the reader expected.
describe('the catalogue version', () => {
  const { version, fingerprint } = loadCatalogue().version;

  it('reports the version the bump script recorded, whatever JSON type it used', () => {
    const onDisk = JSON.parse(readFileSync(join(APP_ROOT, 'config', 'controls', 'version.json'), 'utf8')) as {
      version: unknown;
    };

    expect(version).toBe(String(onDisk.version));
    expect(version).not.toBe('0.0.0');
  });

  it('carries the fingerprint that comparability actually keys on', () => {
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('never lets two unreadable catalogues look like they asked the same questions', () => {
    // An existing directory with no version.json, so the read fails where it is meant
    // to rather than at readdir. A fixed placeholder here would compare equal to itself
    // and the trend view would draw a line between two scans that share only ignorance.
    const empty = mkdtempSync(join(tmpdir(), 'waf-catalogue-'));

    const first = loadCatalogue(empty).version;
    const second = loadCatalogue(empty).version;

    expect(first.version).toBe('unknown');
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});
