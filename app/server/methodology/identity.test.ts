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
    expect(PUBLIC_METHODOLOGY.publicVersion).toBe(3);
    expect(PUBLIC_METHODOLOGY.state).toBe('candidate');
    expect(PUBLIC_METHODOLOGY.candidateStartedAt).toBe('2026-11-09');
    expect(PUBLIC_METHODOLOGY.effectiveDate).toBeUndefined();
    expect(PUBLIC_METHODOLOGY.releaseCommit).toBeUndefined();
    expect(PUBLIC_METHODOLOGY.approvedBy).toBeUndefined();
    expect(PUBLIC_METHODOLOGY.manifestDigest).toBe(
      'sha256:5d3ead9404c15f3fd4f930cfe6b44a8be6cd4fdd511d649ae63c3460c1748ff4'
    );
  });

  it('keeps every shipped version, with Version 1 the exact released artefact', () => {
    expect(SHIPPED_METHODOLOGIES.map((one) => one.publicVersion)).toEqual([1, 2, 3]);
    const [first] = SHIPPED_METHODOLOGIES;
    expect(first?.state).toBe('released');
    expect(first?.effectiveDate).toBe('2026-08-28');
    expect(first?.releaseCommit).toBe('60ff57fa7ceb2ca844532376230c0769b9f304ba');
    expect(first?.approvedBy).toBe('Al Thrussell (product owner)');
    expect(first?.manifestDigest).toBe('sha256:30d26e28904afb7e2c95799daef7ee26219c1461728ded11f514435394c99761');
  });

  it('preserves the released Version 2 identity beside the Version 3 candidate', () => {
    expect(SHIPPED_METHODOLOGIES[1]).toMatchObject({
      publicVersion: 2,
      state: 'released',
      effectiveDate: '2026-10-30',
      releaseCommit: '8cd410c28ded4a6d518ae5d39aec501e9948ac5a',
      approvedBy: 'Al Thrussell (product owner)',
      manifestDigest: 'sha256:b37a74119b37489b882713880c32005f5142d0c6da6903c8751d67debf69cffe',
    });
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
