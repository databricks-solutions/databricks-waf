import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM build tooling, deliberately outside the tsconfig project
import { extractHeadings, toStructure } from '../scripts/harvest-waf-docs.mjs';

// These tests pin the two parsing behaviours that were originally wrong and
// produced a silently useless harvest: unquoted id attributes came back null, and
// the zero-width space in Docusaurus hash-links ended up inside every title. Both
// failures are quiet — the harvest still "succeeds" and yields plausible output —
// which is exactly why they are worth a regression test.

const PAGE = `
<h2 class="anchor" id=1-unify-data-and-ai-management>1. Unify data and AI management<a href=#1-unify-data-and-ai-management class=hash-link aria-label="Direct link to heading" title="Direct link">&#8203;</a></h2>
<h3 class="anchor" id=establish-a-process>Establish a data and AI governance process<a href=#establish-a-process class=hash-link>&#8203;</a></h3>
<h3 class="anchor" id=design-unity-catalog>Design Unity Catalog for your organization<a href=#design-unity-catalog class=hash-link>&#8203;</a></h3>
<h2 class="anchor" id=additional-resources>Additional Resources<a href=#additional-resources class=hash-link>&#8203;</a></h2>
`;

const PILLAR = { code: 'DG', slug: 'data-governance' };

describe('extractHeadings', () => {
  it('reads unquoted id attributes', () => {
    const headings = extractHeadings(PAGE);
    expect(headings[0].id).toBe('1-unify-data-and-ai-management');
    expect(headings[1].id).toBe('establish-a-process');
  });

  it('strips the hash-link anchor and its zero-width space from titles', () => {
    const [first] = extractHeadings(PAGE);
    expect(first.text).toBe('1. Unify data and AI management');
    expect(first.text).not.toMatch(/\u200b/);
    expect(first.text).not.toMatch(/Direct link/);
  });

  it('drops page furniture that is not framework content', () => {
    const texts = extractHeadings(PAGE).map((h) => h.text);
    expect(texts).not.toContain('Additional Resources');
  });
});

describe('toStructure', () => {
  it('nests best practices under their principle and assigns stable ids', () => {
    const principles = toStructure(PILLAR, PAGE);
    expect(principles).toHaveLength(1);
    expect(principles[0].id).toBe('DG-01');
    expect(principles[0].best_practices.map((b: { id: string }) => b.id)).toEqual(['DG-01-01', 'DG-01-02']);
  });

  it('builds a source anchor that deep-links to the harvested section', () => {
    const [principle] = toStructure(PILLAR, PAGE);
    expect(principle.best_practices[0].source_anchor).toBe(
      'https://docs.databricks.com/aws/en/lakehouse-architecture/data-governance/best-practices#establish-a-process'
    );
  });
});
