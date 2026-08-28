// What a bump writes down, exercised against a small catalogue in a temporary directory.
//
// The record this script keeps is what lets a customer's trend survive a catalogue update, and it is
// written once per release and read for years. There is no way to notice afterwards that a bump
// described a renumbering as an addition beside a removal — the two catalogues it compared are gone
// by then, and the entry reads as a fact. So the description has to be right at the moment it is
// written, which is the only moment these tests can check it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'catalogue-version.mjs');

interface ControlShape {
  readonly id: string;
  readonly title?: string;
  readonly severity?: string;
  readonly continues?: string;
}

interface ChangelogEntry {
  readonly version: number;
  readonly describes: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  readonly changed: readonly { readonly id: string; readonly fields: readonly string[] }[];
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function catalogueOf(controls: readonly ControlShape[], pillar = 'reliability'): string {
  const body = controls
    .map((control) =>
      [
        `      - id: ${control.id}`,
        `        title: ${control.title ?? control.id}`,
        `        severity: ${control.severity ?? 'high'}`,
        '        provenance: waf-docs',
        '        measurability: system-table',
        '        evaluator_status: implemented',
        ...(control.continues != null ? [`        continues: ${control.continues}`] : []),
      ].join('\n'),
    )
    .join('\n');

  return [
    'pillar:',
    `  code: ${pillar}`,
    `  name: ${pillar}`,
    'principles:',
    `  - id: ${pillar}-1`,
    '    name: One',
    '    controls:',
    body,
    '',
  ].join('\n');
}

// A second pillar file, so a removal and an addition can be made to have nothing in common.
function writePillar(directory: string, pillar: string, controls: readonly ControlShape[]): void {
  writeFileSync(join(directory, `${pillar}.yaml`), catalogueOf(controls, pillar));
}

function directoryWith(controls: readonly ControlShape[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'waf-catalogue-'));
  directories.push(directory);
  writeFileSync(join(directory, 'reliability.yaml'), catalogueOf(controls));
  return directory;
}

function run(directory: string, ...flags: string[]): { readonly out: string; readonly code: number } {
  try {
    return { out: execFileSync('node', [SCRIPT, '--dir', directory, ...flags], { encoding: 'utf8' }), code: 0 };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { out: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, code: failure.status ?? 1 };
  }
}

function rewrite(directory: string, controls: readonly ControlShape[]): void {
  writeFileSync(join(directory, 'reliability.yaml'), catalogueOf(controls));
}

function changelogOf(directory: string): readonly ChangelogEntry[] {
  return JSON.parse(readFileSync(join(directory, 'changelog.json'), 'utf8')) as ChangelogEntry[];
}

function versionOf(directory: string): { readonly version: number; readonly controls?: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(directory, 'version.json'), 'utf8')) as { version: number };
}

describe('establishing a catalogue version', () => {
  it('records version 1 and the shapes it covers', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b' }]);

    expect(run(directory).code).toBe(0);
    expect(versionOf(directory).version).toBe(1);
    expect(Object.keys(versionOf(directory).controls ?? {})).toEqual(['a', 'b']);
  });

  it('records version 1 as undescribed, since there is no earlier catalogue it changed', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);

    expect(changelogOf(directory)[0]?.describes).toBe(false);
  });

  it('refuses to establish a version under --check, where writing would hide the omission', () => {
    const directory = directoryWith([{ id: 'a' }]);

    const { code, out } = run(directory, '--check');
    expect(code).toBe(1);
    expect(out).toContain('No version.json recorded');
    expect(existsSync(join(directory, 'version.json'))).toBe(false);
  });
});

describe('noticing a catalogue that moved', () => {
  it('passes when nothing moved', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);

    const { code, out } = run(directory, '--check');
    expect(code).toBe(0);
    expect(out).toContain('unchanged');
  });

  it('fails when the requirement set moved and the version did not, and says what moved', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'b' }]);

    const { code, out } = run(directory, '--check');
    expect(code).toBe(1);
    expect(out).toContain('was not bumped');
    expect(out).toContain('added:    b');
  });

  it('ignores prose, so fixing a title does not discard a customer’s history', () => {
    const directory = directoryWith([{ id: 'a', title: 'Do the thing' }]);
    run(directory);
    rewrite(directory, [{ id: 'a', title: 'Do the thing properly' }]);

    // Title is in the shape deliberately — it is what a reader sees a requirement as — so this is a
    // real change. The check is that it is *described*, not that it is silently absorbed.
    expect(run(directory, '--check').out).toContain('changed:  a (title)');
  });
});

describe('what a bump writes into the changelog', () => {
  it('names an arriving requirement as an addition', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'b' }]);
    run(directory, '--bump');

    const entry = changelogOf(directory).find((one) => one.version === 2);
    expect(entry?.describes).toBe(true);
    expect(entry?.added).toEqual(['b']);
    expect(entry?.removed).toEqual([]);
  });

  it('pairs a declared continuation as one rename rather than two unrelated moves', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);
    rewrite(directory, [{ id: 'a2', continues: 'a' }]);
    run(directory, '--bump');

    const entry = changelogOf(directory).find((one) => one.version === 2);
    expect(entry?.renamed).toEqual([{ from: 'a', to: 'a2' }]);
    expect(entry?.added).toEqual([]);
    expect(entry?.removed).toEqual([]);
  });

  it('does not pair a continuation of a requirement that is still in the catalogue', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'a2', continues: 'a' }]);
    run(directory, '--bump');

    const entry = changelogOf(directory).find((one) => one.version === 2);
    expect(entry?.renamed).toEqual([]);
    expect(entry?.added).toEqual(['a2']);
  });

  it('names which fields moved on a requirement that stayed', () => {
    const directory = directoryWith([{ id: 'a', severity: 'high' }]);
    run(directory);
    rewrite(directory, [{ id: 'a', severity: 'critical' }]);
    run(directory, '--bump');

    expect(changelogOf(directory).find((one) => one.version === 2)?.changed).toEqual([
      { id: 'a', fields: ['severity'] },
    ]);
  });

  it('carries a renumbered requirement’s field changes under its new id', () => {
    const directory = directoryWith([{ id: 'a', severity: 'high' }]);
    run(directory);
    rewrite(directory, [{ id: 'a2', continues: 'a', severity: 'critical' }]);
    run(directory, '--bump');

    const entry = changelogOf(directory).find((one) => one.version === 2);
    expect(entry?.renamed).toEqual([{ from: 'a', to: 'a2' }]);
    expect(entry?.changed).toEqual([{ id: 'a2', fields: ['severity', 'title'] }]);
  });

  it('keeps every version, so a run stamped with an old one can still be read', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'b' }]);
    run(directory, '--bump');
    rewrite(directory, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    run(directory, '--bump');

    expect(changelogOf(directory).map((one) => one.version)).toEqual([1, 2, 3]);
    expect(versionOf(directory).version).toBe(3);
  });
});

describe('a version that both adds and removes a requirement', () => {
  // A renumbering missing its `continues:` and a real exchange of scope leave identical
  // catalogues, so this cannot be detected — only refused until somebody who knows says which it
  // is. These tests are about the refusal holding, and about the affirmation being specific
  // enough that yesterday's command cannot stand in for today's answer.

  it('refuses the bump, since a forgotten continues: and a real exchange look the same', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'c' }]);

    const { code, out } = run(directory, '--bump');
    expect(code).toBe(1);
    expect(out).toContain('Refusing to guess');
    expect(out).toContain('removed:  b');
    expect(out).toContain('added:    c');
  });

  it('writes nothing when it refuses, so the next attempt starts from the same place', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'c' }]);
    run(directory, '--bump');

    expect(versionOf(directory).version).toBe(1);
    expect(changelogOf(directory).map((one) => one.version)).toEqual([1]);
  });

  it('names the pair it noticed, so the author is answering rather than dismissing', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b', title: 'Back up the metastore' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'c', title: 'Back up the metastore' }]);

    expect(run(directory, '--bump').out).toContain('b -> c, the same title');
  });

  it('still refuses when it noticed nothing, since noticing nothing is not evidence', () => {
    // Different pillar and different title, which is every ground it has. The refusal has to
    // survive that: a renumbering that also moved pillar and reworded the requirement leaves
    // nothing to notice it by, and is exactly the case where a silent guess would be worst.
    const directory = directoryWith([{ id: 'a' }]);
    writePillar(directory, 'cost', [{ id: 'b', title: 'Tag the clusters' }]);
    run(directory);
    rmSync(join(directory, 'cost.yaml'));
    rewrite(directory, [{ id: 'a' }, { id: 'c', title: 'Back up the metastore' }]);

    const { code, out } = run(directory, '--bump');
    expect(code).toBe(1);
    expect(out).toContain('Nothing here looks like a pair');
  });

  it('proceeds once the additions are affirmed as renumbering nothing', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'c' }]);

    expect(run(directory, '--bump', '--unrelated', 'c').code).toBe(0);
    const entry = changelogOf(directory).find((one) => one.version === 2);
    expect(entry?.added).toEqual(['c']);
    expect(entry?.removed).toEqual(['b']);
  });

  it('refuses an affirmation that misses an addition, so one release cannot affirm the next', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'c' }, { id: 'd' }]);

    const { code, out } = run(directory, '--bump', '--unrelated', 'c');
    expect(code).toBe(1);
    expect(out).toContain('does not account for d');
  });

  it('refuses an affirmation naming something this version does not add', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'c' }]);

    const { code, out } = run(directory, '--bump', '--unrelated', 'c,zz');
    expect(code).toBe(1);
    expect(out).toContain('which this version does not add');
  });

  it('refuses a bare --unrelated, which affirms nothing while looking like it affirms everything', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'c' }]);

    expect(run(directory, '--bump', '--unrelated').code).toBe(1);
  });

  it('refuses the flag where there is no exchange to affirm, rather than accepting it as harmless', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'b' }]);

    const { code, out } = run(directory, '--bump', '--unrelated', 'b');
    expect(code).toBe(1);
    expect(out).toContain('nothing for');
  });

  it('does not ask when the renumbering was declared, since then there is no exchange left', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'c', continues: 'b' }]);

    expect(run(directory, '--bump').code).toBe(0);
    expect(changelogOf(directory).find((one) => one.version === 2)?.renamed).toEqual([{ from: 'b', to: 'c' }]);
  });

  it('still asks about the additions a partial declaration left over', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'b2', continues: 'b' }, { id: 'd' }]);

    const { code, out } = run(directory, '--bump');
    expect(code).toBe(1);
    expect(out).toContain('added:    d');
    expect(out).toContain('removed:  c');
    // The declared pair is accounted for and must not be asked about again.
    expect(out).not.toContain('b2');
  });

  it('mentions it in the report too, where declaring a continues: is still cheap', () => {
    const directory = directoryWith([{ id: 'a' }, { id: 'b' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'c' }]);

    const { code, out } = run(directory, '--check');
    expect(code).toBe(1);
    expect(out).toContain('both adds and removes requirements');
    expect(out).toContain('b -> c, the same pillar and principle');
  });
});

describe('a record written before control shapes existed', () => {
  function withoutShapes(directory: string): void {
    const record = JSON.parse(readFileSync(join(directory, 'version.json'), 'utf8')) as Record<string, unknown>;
    delete record.controls;
    writeFileSync(join(directory, 'version.json'), `${JSON.stringify(record, null, 2)}\n`);
  }

  it('fills the shapes in without bumping, since the requirement set did not move', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);
    withoutShapes(directory);

    const { out } = run(directory);
    expect(out).toContain('unchanged');
    expect(versionOf(directory).version).toBe(1);
    expect(Object.keys(versionOf(directory).controls ?? {})).toEqual(['a']);
  });

  it('passes --check meanwhile, because nothing about the requirement set is unrecorded', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);
    withoutShapes(directory);

    const { code, out } = run(directory, '--check');
    expect(code).toBe(0);
    expect(out).toContain('predates control shapes');
  });

  it('marks a version bumped from a shapeless record as undescribed rather than guessing', () => {
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);
    withoutShapes(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'b' }]);
    run(directory, '--bump');

    expect(changelogOf(directory).find((one) => one.version === 2)?.describes).toBe(false);
  });

  it('does not downgrade a described entry when the shapes are backfilled onto it', () => {
    // The reachable way history got rewritten. Backfilling shapes records the *current* version with
    // nothing to describe, so a version.json that had lost its shapes turned that version's
    // described entry into an undescribed one on a plain `catalogue:version` — and every comparison
    // across it silently became a refusal, from a command that reports rather than changes anything.
    const directory = directoryWith([{ id: 'a' }]);
    run(directory);
    rewrite(directory, [{ id: 'a' }, { id: 'b' }]);
    run(directory, '--bump');
    expect(changelogOf(directory).find((one) => one.version === 2)?.describes).toBe(true);

    withoutShapes(directory);
    run(directory);

    const entry = changelogOf(directory).find((one) => one.version === 2);
    expect(entry?.describes).toBe(true);
    expect(entry?.added).toEqual(['b']);
  });
});
