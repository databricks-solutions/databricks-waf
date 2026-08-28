// The bump writes the changelog and this module reads it, and nothing else holds the two together.
//
// They are a JavaScript script and a TypeScript module, in different directories, agreeing about
// field names by convention. `scored_units` is snake_case on disk and camelCase in the interface;
// `renamed` is an array of pairs one side and composed into a map on the other. Either could be
// renamed in a refactor of one file, and every test in the suite would still pass — the writer's
// tests read what the writer wrote, and the reader's tests read fixtures written by hand to match.
//
// The failure that leaves is silent in the worst way. `loadChangelog` tolerates a malformed entry by
// design, because an unreadable changelog must not stop the app booting. So a field the script stops
// writing does not throw: it produces an entry that parses, describes nothing, and refuses every
// comparison across a version — which is indistinguishable from the honest refusal for a version
// recorded before shapes existed.
//
// So this drives the real script over a real catalogue and reads the result with the real loader.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadChangelog, spanBetween } from './changelog.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'catalogue-version.mjs');

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function control(
  id: string,
  options: { readonly severity?: string; readonly continues?: string; readonly title?: string } = {},
): string {
  return [
    `      - id: ${id}`,
    // Titles are part of the scoring shape, so a renumbering that also retitles reports both — which
    // is correct and is not what this fixture is isolating. `continues` carries the title across.
    `        title: ${options.title ?? id}`,
    `        severity: ${options.severity ?? 'high'}`,
    '        provenance: waf-docs',
    '        measurability: system-table',
    '        evaluator_status: implemented',
    ...(options.continues != null ? [`        continues: ${options.continues}`] : []),
  ].join('\n');
}

function write(directory: string, controls: readonly string[]): void {
  writeFileSync(
    join(directory, 'reliability.yaml'),
    ['pillar:', '  code: reliability', '  name: Reliability', 'principles:', '  - id: rel-1', '    name: One', '    controls:', ...controls, ''].join(
      '\n',
    ),
  );
}

function bump(directory: string, ...flags: readonly string[]): void {
  execFileSync('node', [SCRIPT, '--dir', directory, '--bump', ...flags], { encoding: 'utf8' });
}

/** Three versions of a small catalogue, exercising every kind of move the record can hold. */
function catalogueWithHistory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'waf-agreement-'));
  directories.push(directory);

  write(directory, [control('a'), control('b'), control('c')]);
  execFileSync('node', [SCRIPT, '--dir', directory], { encoding: 'utf8' });

  // Version 2: `c` leaves, `d` arrives, `b` is re-severitied. A version that both adds and removes
  // has to say the exchange is real rather than a renumbering missing its `continues:`, which is
  // what this fixture means — `d` is a new requirement, not `c` under another number.
  write(directory, [control('a'), control('b', { severity: 'critical' }), control('d')]);
  bump(directory, '--unrelated', 'd');

  // Version 3: `a` is renumbered to `a2` and nothing else about it moves.
  write(directory, [
    control('a2', { continues: 'a', title: 'a' }),
    control('b', { severity: 'critical' }),
    control('d'),
  ]);
  bump(directory);

  return directory;
}

describe('the record the bump writes is the record the app reads', () => {
  it('reads back every version the bump recorded', () => {
    const changelog = loadChangelog(catalogueWithHistory());

    expect(changelog.entries.map((one) => one.version)).toEqual(['1', '2', '3']);
  });

  it('reads a version as describing itself, which is what permits a comparison across it', () => {
    const changelog = loadChangelog(catalogueWithHistory());

    // Version 1 describes nothing because there is no earlier catalogue it changed; 2 and 3 do.
    expect(changelog.entries.map((one) => one.describes)).toEqual([false, true, true]);
  });

  it('reads the scored count, which is written under a different name than it is read by', () => {
    const changelog = loadChangelog(catalogueWithHistory());

    expect(changelog.entries.at(-1)?.scoredUnits).toBe(3);
  });

  it('composes the whole history into one span the app can act on', () => {
    const span = spanBetween(loadChangelog(catalogueWithHistory()), '1', '3');

    expect(span.describable).toBe(true);
    expect(span.added).toEqual(['d']);
    expect(span.removed).toEqual(['c']);
    expect(span.renamed.get('a')).toBe('a2');
    expect(span.changed).toEqual([{ id: 'b', fields: ['severity'] }]);
  });

  it('composes a single step of that history without carrying the rest of it', () => {
    const span = spanBetween(loadChangelog(catalogueWithHistory()), '2', '3');

    expect(span.added).toEqual([]);
    expect(span.removed).toEqual([]);
    expect(span.renamed.get('a')).toBe('a2');
  });

  it('still refuses the span out of version 1, which describes nothing', () => {
    // The state the real catalogue is in: version 9 exists and what it changed was not written down.
    // Worth holding, because the whole feature is an exception to a refusal and the refusal has to
    // survive it.
    expect(spanBetween(loadChangelog(catalogueWithHistory()), '0', '3').describable).toBe(false);
  });
});
