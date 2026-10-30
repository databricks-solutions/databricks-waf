import { describe, expect, it } from 'vitest';
import { PUBLIC_METHODOLOGY, SHIPPED_METHODOLOGIES, publicMethodologyFrom } from './identity.js';

const release = {
  public_version: 1,
  name: 'Methodology Version 1',
  state: 'candidate',
  candidate_started_at: '2026-08-19',
  effective_date: null,
  release_commit: null,
  approved_by: null,
};

const manifest = {
  public_version: 1,
  name: 'Methodology Version 1',
  manifest_digest: 'sha256:manifest',
  release: {
    state: 'candidate',
    candidate_started_at: '2026-08-19',
    effective_date: null,
    commit: null,
    approved_by: null,
  },
};

describe('the public methodology identity', () => {
  it('stamps new records with the highest public version this build ships', () => {
    expect(PUBLIC_METHODOLOGY.publicVersion).toBe(2);
    expect(PUBLIC_METHODOLOGY.state).toBe('candidate');
    expect(PUBLIC_METHODOLOGY.effectiveDate).toBeUndefined();
    expect(PUBLIC_METHODOLOGY.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps every shipped version, with Version 1 the exact released artefact', () => {
    expect(SHIPPED_METHODOLOGIES.map((one) => one.publicVersion)).toEqual([1, 2]);
    const [first] = SHIPPED_METHODOLOGIES;
    expect(first?.state).toBe('released');
    expect(first?.effectiveDate).toBe('2026-08-28');
    expect(first?.releaseCommit).toBe('60ff57fa7ceb2ca844532376230c0769b9f304ba');
    expect(first?.approvedBy).toBe('Al Thrussell (product owner)');
    expect(first?.manifestDigest).toBe('sha256:30d26e28904afb7e2c95799daef7ee26219c1461728ded11f514435394c99761');
  });

  it('refuses a release record and manifest that name different public versions', () => {
    expect(() => publicMethodologyFrom({ ...release, public_version: 2 }, manifest)).toThrow(
      /disagree.*public version/i
    );
  });

  it('refuses to call a release complete without an effective date', () => {
    expect(() =>
      publicMethodologyFrom(
        { ...release, state: 'released' },
        { ...manifest, release: { ...manifest.release, state: 'released' } }
      )
    ).toThrow(/effective date/i);
  });

  it('refuses release facts that disagree with the generated manifest', () => {
    expect(() =>
      publicMethodologyFrom(
        { ...release, release_commit: 'a'.repeat(40) },
        { ...manifest, release: { ...manifest.release, commit: 'b'.repeat(40) } }
      )
    ).toThrow(/disagree.*source commit/i);
  });
});
