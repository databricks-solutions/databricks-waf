// Which files the link check reads, and whether it can quietly stop reading one.
//
// Row 67 exists because `serverless-rules.yaml` held seventeen citations that nothing fetched for
// three months, while a workflow named "Official skill drift" reported success every week. Nobody
// wrote that gap; it appeared because the collector read one directory and the file that needed
// watching was in another. So these tests are less about parsing YAML than about the shape of that
// failure: a source that returns nothing, a rule kind that stops being carried, an id that goes
// missing from the report.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDANCE_DIR, RULES_FILE, guidanceCitations, rulesetCitations } from './guidance-citations.mjs';

describe('the serverless ruleset', () => {
  const found = rulesetCitations(RULES_FILE);

  it('cites a page for every rule and assumption that declares one', () => {
    // Not a fixture. The file is the thing at risk, and a fixture would pass while it emptied.
    expect(found.length).toBeGreaterThan(10);
    for (const one of found) expect(one.url).toMatch(/^https:\/\//);
  });

  it('says which rule or assumption each citation belongs to', () => {
    for (const one of found) expect(one.where).toMatch(/^serverless-rules\.yaml (rule|assumption) \S+$/);
  });

  it('carries both lists, because both are shown to a reader', () => {
    expect(found.some((one) => one.where.includes(' rule '))).toBe(true);
    expect(found.some((one) => one.where.includes(' assumption '))).toBe(true);
  });

  it('marks a blocker absolute and nothing else', () => {
    // A blocker is the rule that says the work cannot move, and it is the one whose wording a lifted
    // limitation makes wrong while the URL still resolves. Two of them today; the count is not
    // asserted, because rules are meant to be added.
    const marked = found.filter((one) => one.absolute);
    expect(marked.length).toBeGreaterThan(0);
    for (const one of marked) expect(one.where).toContain(' rule ');
    expect(found.filter((one) => one.where.includes(' assumption ')).every((one) => !one.absolute)).toBe(true);
  });
});

describe('the answering guidance', () => {
  it('still contributes the bulk of the citations', () => {
    // Both sources have to be non-empty for the check to be checking what it reports. The guidance is
    // the larger of the two, and a change that made it return nothing would otherwise look like the
    // ruleset passing.
    expect(guidanceCitations(GUIDANCE_DIR).length).toBeGreaterThan(rulesetCitations(RULES_FILE).length);
  });
});

describe('a citation that is not a citation', () => {
  const fixture = (body: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'citations-')), 'serverless-rules.yaml');
    writeFileSync(file, body);
    return file;
  };

  it('ignores a doc_url that is not a URL, rather than fetching it', () => {
    // `doc_url: see the runbook` is a plausible thing to write, and fetching it fails in a way that
    // reads as a dead page rather than as a malformed entry — a report that blames the wrong party.
    const file = fixture(
      'rules:\n  - id: prose\n    kind: blocker\n    doc_url: see the runbook\n  - id: real\n    kind: rework\n    doc_url: https://example.test/a\n'
    );

    expect(rulesetCitations(file).map((one) => one.url)).toEqual(['https://example.test/a']);
  });

  it('returns nothing for a ruleset with neither list, rather than throwing', () => {
    // The caller turns empty into the error, because empty from one source and empty from both are
    // different failures and only the caller knows which it is looking at.
    expect(rulesetCitations(fixture('version: 1\n'))).toEqual([]);
  });
});
