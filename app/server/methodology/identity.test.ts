import { describe, expect, it } from 'vitest';
import { PUBLIC_METHODOLOGY, publicMethodologyFrom } from './identity.js';

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
  it('loads the exact released methodology this build ships', () => {
    expect(PUBLIC_METHODOLOGY.publicVersion).toBe(1);
    expect(PUBLIC_METHODOLOGY.state).toBe('released');
    expect(PUBLIC_METHODOLOGY.effectiveDate).toBe('2026-08-28');
    expect(PUBLIC_METHODOLOGY.releaseCommit).toBe('60ff57fa7ceb2ca844532376230c0769b9f304ba');
    expect(PUBLIC_METHODOLOGY.approvedBy).toBe('Al Thrussell (product owner)');
    expect(PUBLIC_METHODOLOGY.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
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
