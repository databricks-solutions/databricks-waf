import { describe, expect, it } from 'vitest';
import { methodologyLabel, methodologyProvenance } from './methodology-identity';

describe('customer methodology labels', () => {
  it('does not promote a development catalogue revision into Version 1', () => {
    const stamp = { catalogueVersion: '18' };
    expect(methodologyLabel(stamp)).toBe('Pre-release development');
    expect(methodologyProvenance(stamp)).toBe('Pre-release development · catalogue revision 18');
  });

  it('keeps candidate state visible', () => {
    const stamp = {
      catalogueVersion: '18',
      publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:one', state: 'candidate' as const },
    };
    expect(methodologyLabel(stamp)).toBe('Methodology Version 1 candidate');
  });

  it('shows a released public version apart from the technical revision', () => {
    const stamp = {
      catalogueVersion: '19',
      publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:one', state: 'released' as const },
    };
    expect(methodologyProvenance(stamp)).toBe('Methodology Version 1 · catalogue revision 19');
  });

  it('names a Version 2 candidate as a candidate', () => {
    const stamp = {
      catalogueVersion: '19',
      publicMethodology: { publicVersion: 2, manifestDigest: 'sha256:two', state: 'candidate' as const },
    };
    expect(methodologyLabel(stamp)).toBe('Methodology Version 2 candidate');
  });

  it('labels the interim Version 1 digest without rewriting the stored stamp', () => {
    const stamp = {
      catalogueVersion: '18',
      publicMethodology: {
        publicVersion: 1,
        manifestDigest: 'sha256:3ffb685e36d092c91f52a93a172c1db7e32a2ec5f88f3efdab361390eb0dd71f',
        state: 'released' as const,
      },
    };
    const before = JSON.stringify(stamp);

    expect(methodologyLabel(stamp)).toBe('Methodology Version 1 (unreleased interim variant of Version 1)');
    expect(methodologyProvenance(stamp)).toContain('unreleased interim variant of Version 1');
    expect(JSON.stringify(stamp)).toBe(before);
  });

  it('does not label released Version 1 as interim', () => {
    const stamp = {
      catalogueVersion: '18',
      publicMethodology: {
        publicVersion: 1,
        manifestDigest: 'sha256:30d26e28904afb7e2c95799daef7ee26219c1461728ded11f514435394c99761',
        state: 'released' as const,
      },
    };
    expect(methodologyLabel(stamp)).toBe('Methodology Version 1');
  });
});
