import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authoredGuidance, guidanceDirectory, loadGuidance } from './guidance.js';

/**
 * The loader, and the shipped files it will actually read.
 *
 * Split deliberately: the first half proves the reader is defensive about content it did not write,
 * and the second proves the content this repository ships parses into what the app expects. Only the
 * second would notice a YAML mistake in an authored entry, and only the first would notice the
 * reader crashing on one.
 */

function library(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'waf-guidance-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body, 'utf8');
  return loadGuidance(directory);
}

const AUTHORED = `
pillar: reliability
entries:
  REL-01-02:
    status: authored
    last_reviewed: '2026-08-02'
    owner_role: Platform owner
    means: A sentence about what the practice actually is, in plain terms.
    matters: A sentence about the risk of not doing it, stated as a consequence.
    good:
      - The first signal an answer is measured against.
      - The second signal an answer is measured against.
    examples:
      strong: What a strong answer looks like in an estate.
      partial: What a partial answer looks like in an estate.
      weak: What a weak answer looks like in an estate.
    verify:
      - how: sql
        where: select * from system.compute.clusters
        expect: Every cluster on a supported runtime
        caveat: Deleted clusters are still rows here, so this counts more than exist.
      - how: ui
        where: A cluster's configuration
        expect: A supported runtime, chosen rather than inherited
    pitfalls:
      - The way this is commonly got wrong.
    partial_when: When half of it is in place.
    references:
      - https://docs.databricks.com/aws/en/index.html
`;

describe('reading guidance', () => {
  it('reads an authored entry into the fields the panel needs', () => {
    const { entries, authored } = library({ 'reliability.yaml': AUTHORED });
    const entry = entries.get('REL-01-02');

    expect(authored).toBe(1);
    expect(entry?.status).toBe('authored');
    expect(entry?.pillarId).toBe('reliability');
    expect(entry?.ownerRole).toBe('Platform owner');
    expect(entry?.good).toHaveLength(2);
    expect(entry?.verify[0]).toEqual({
      how: 'sql',
      where: 'select * from system.compute.clusters',
      expect: 'Every cluster on a supported runtime',
      caveat: 'Deleted clusters are still rows here, so this counts more than exist.',
    });
    // Absent rather than present and undefined, so a step without one does not ship a null line to the
    // panel. The pair matters: an equality against a fixture that has no caveat passes just as happily
    // when the loader has stopped reading the field at all, which is how this arrived unguarded.
    expect(entry?.verify[1]).toEqual({
      how: 'ui',
      where: "A cluster's configuration",
      expect: 'A supported runtime, chosen rather than inherited',
    });
    expect(entry?.examples?.partial).toContain('partial answer');
    expect(entry?.lastReviewed).toBe('2026-08-02');
  });

  it('reads a scaffold as a draft, and a draft is not guidance', () => {
    const { entries, authored } = library({
      'reliability.yaml': 'pillar: reliability\nentries:\n  REL-01-02:\n    status: draft\n',
    });

    expect(authored).toBe(0);
    expect(entries.get('REL-01-02')?.status).toBe('draft');
    expect(authoredGuidance({ entries, authored, advised: 0 }, 'REL-01-02')).toBeUndefined();
  });

  /*
   * A draft is withheld rather than shown, which is the whole reason `status` exists.
   *
   * An entry with three of nine fields written renders as a panel with headings and nothing under
   * them, and reads as a bug in the app rather than as work not yet done. The sentence "no guidance
   * has been written for this question yet" tells a reader to ask a colleague; a half-empty panel
   * tells them nothing and costs them the click.
   */
  it('withholds a half-written entry, however much of it is there', () => {
    const half = `
pillar: reliability
entries:
  REL-01-02:
    status: draft
    means: Something somebody started writing.
    matters: And a second field they got to.
`;
    const found = library({ 'reliability.yaml': half });

    expect(found.entries.get('REL-01-02')?.means).toContain('started writing');
    expect(authoredGuidance(found, 'REL-01-02')).toBeUndefined();
  });

  it('treats an entry that claims nothing as a draft rather than trusting it', () => {
    const found = library({ 'reliability.yaml': 'pillar: reliability\nentries:\n  REL-01-02: {}\n' });
    expect(found.entries.get('REL-01-02')?.status).toBe('draft');
  });

  it('survives a file with no entries, an empty file and an unreadable entry', () => {
    const found = library({
      'reliability.yaml': 'pillar: reliability\n',
      'cost-optimization.yaml': '',
      'performance-efficiency.yaml': 'pillar: performance-efficiency\nentries:\n  PE-01-01:\n',
    });

    expect(found.entries.size).toBe(0);
    expect(found.authored).toBe(0);
  });

  /*
   * A check with no `where` is dropped rather than kept as an empty one.
   *
   * The schema requires it, so this is only reachable from a hand edit that skipped the gate. The
   * choice matters anyway: a verification step that names no location is an instruction to look
   * somewhere unspecified, which wastes a reader's time more thoroughly than having one step fewer.
   */
  it('drops a verification step that names no location', () => {
    const found = library({
      'reliability.yaml': 'pillar: reliability\nentries:\n  REL-01-02:\n    status: draft\n    verify:\n      - how: ui\n',
    });

    expect(found.entries.get('REL-01-02')?.verify).toEqual([]);
  });

  it('falls back to by-hand for a check kind it does not recognise', () => {
    const found = library({
      'reliability.yaml':
        'pillar: reliability\nentries:\n  REL-01-02:\n    status: draft\n    verify:\n      - how: telepathy\n        where: Ask the platform team\n',
    });

    expect(found.entries.get('REL-01-02')?.verify[0]?.how).toBe('by-hand');
  });
});

describe('the guidance this repository ships', () => {
  const shipped = loadGuidance(guidanceDirectory());

  it('has an entry for every question, and they parse', () => {
    // The count itself is scripts/check-guidance.mjs's job, against the catalogue and the floor in
    // config/guidance/authored.json. Reading that floor rather than restating it keeps the number in
    // one place: a copy here went stale the first time a question became a measure.
    const floor = JSON.parse(readFileSync(join(guidanceDirectory(), 'authored.json'), 'utf8')) as {
      authored: number;
    };

    expect(shipped.entries.size).toBeGreaterThanOrEqual(floor.authored);
  });

  it('reads every authored entry as complete enough to render', () => {
    const incomplete = [...shipped.entries.values()]
      .filter((one) => one.status === 'authored')
      .filter(
        (one) =>
          one.means == null ||
          one.matters == null ||
          one.examples == null ||
          one.partialWhen == null ||
          one.good.length < 2 ||
          one.verify.length === 0 ||
          one.pitfalls.length === 0
      )
      .map((one) => one.controlId);

    expect(incomplete).toEqual([]);
  });

  it('carries at least one authored entry, so the shape is proven by content and not only by fixtures', () => {
    expect(shipped.authored).toBeGreaterThan(0);
  });

  it('carries advice on at least one entry, and reads every one of them whole', () => {
    // The same argument as the line above, for the second half of the contract: a schema and a panel
    // that no shipped entry exercises are a shape nobody has run content through.
    expect(shipped.advised).toBeGreaterThan(0);

    // Every field the panel renders, over the entries the loader reports as advised. `toAdvice`
    // already drops a block missing one, so what this catches is the two of them disagreeing —
    // a field added to the panel and not to the loader's guard, which renders as an empty heading.
    const partial = [...shipped.entries.values()]
      .filter((one) => one.advice != null)
      .filter(
        (one) =>
          one.advice!.dependsOn.length === 0 ||
          one.advice!.path.length === 0 ||
          one.advice!.costs.length === 0 ||
          one.advice!.startFrom.trim() === '' ||
          one.advice!.retain.trim() === '' ||
          one.advice!.revisit.trim() === ''
      )
      .map((one) => one.controlId);

    expect(partial).toEqual([]);
  });

  it('counts advice against its own floor, which is not a share of the authored one', () => {
    const floor = JSON.parse(readFileSync(join(guidanceDirectory(), 'authored.json'), 'utf8')) as {
      authored: number;
      advised: number;
    };

    expect(shipped.advised).toBeGreaterThanOrEqual(floor.advised);
  });
});

describe('an advice block the reader did not write', () => {
  const withAdvice = (body: string) => `${AUTHORED}    advice:\n${body}`;

  const WHOLE = [
    "      start_from: The default for a customer with no policy, at enough length to clear the floor.",
    '      depends_on:',
    '        - The first condition that changes it, and what it changes it to.',
    '        - The second condition that changes it, and what it changes it to.',
    '      path:',
    '        - Find out what the estate does today, which is the step people skip.',
    '        - Then move it to the baseline, which is where the value is.',
    '      costs:',
    '        - What it costs to run, in money or in somebody spending a week.',
    '      retain: The dated artefact that proves this at the next review.',
    '      revisit: The event that should reopen the decision, rather than a date.',
  ].join('\n');

  it('reads all six into the block the panel renders', () => {
    const entry = library({ 'reliability.yaml': withAdvice(WHOLE) }).entries.get('REL-01-02');

    expect(entry?.advice?.dependsOn).toHaveLength(2);
    expect(entry?.advice?.path).toHaveLength(2);
    expect(entry?.advice?.startFrom).toMatch(/no policy/);
    expect(entry?.advice?.revisit).toMatch(/reopen the decision/);
  });

  /*
   * The rule the schema enforces, enforced again here for the case the schema does not see.
   *
   * `check:guidance` refuses a partial block in CI. This is a hand edit between checks, or a file
   * the app was pointed at that never went through the gate — and the answer is to drop the block
   * rather than render five headings and a gap where the sixth was, because the panel's headings
   * would otherwise announce a trade-off nobody wrote.
   */
  it.each([
    ['start_from', /^ +start_from:.*$/m],
    ['retain', /^ +retain:.*$/m],
    ['revisit', /^ +revisit:.*$/m],
  ])('drops the whole block when %s is missing, rather than rendering a gap', (_field, line) => {
    const entry = library({ 'reliability.yaml': withAdvice(WHOLE.replace(line, '')) }).entries.get('REL-01-02');

    expect(entry?.advice).toBeUndefined();
    // The rest of the entry still reads, because one broken block is not a broken entry.
    expect(entry?.status).toBe('authored');
    expect(entry?.means).not.toBeUndefined();
  });

  it('drops it when a list is present and empty, which YAML makes easy to write', () => {
    const entry = library({
      'reliability.yaml': withAdvice(WHOLE.replace(/ {6}costs:\n {8}- .*/, '      costs: []')),
    }).entries.get('REL-01-02');

    expect(entry?.advice).toBeUndefined();
  });
});
