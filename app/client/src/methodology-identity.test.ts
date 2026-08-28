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
});
