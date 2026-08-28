import { describe, expect, it } from 'vitest';
import {
  assertReleasedMetadata,
  assertReleaseTransition,
  releasedMethodologyChanged,
} from './methodology-release-policy.js';

const candidate = {
  public_version: 1,
  release: {
    state: 'candidate',
    candidate_started_at: '2026-08-19',
    effective_date: null,
    commit: null,
    approved_by: null,
    approval_required_role: 'product owner',
  },
  requirements: [{ id: 'OE-01-01', scoring: { severity: 'high' } }],
  digests: { methodology_content: 'sha256:methodology' },
  manifest_digest: 'sha256:candidate',
};

const released = {
  ...candidate,
  release: {
    ...candidate.release,
    state: 'released',
    effective_date: '2026-08-28',
    commit: '60ff57fa7ceb2ca844532376230c0769b9f304ba',
    approved_by: 'Al Thrussell (product owner)',
  },
  manifest_digest: 'sha256:released',
};

describe('the Methodology Version 1 release boundary', () => {
  it('requires complete release facts', () => {
    expect(() =>
      assertReleasedMetadata({
        state: 'released',
        effective_date: '2026-08-28',
        release_commit: '60ff57fa7ceb2ca844532376230c0769b9f304ba',
        approved_by: 'Al Thrussell (product owner)',
      })
    ).not.toThrow();
    expect(() => assertReleasedMetadata({ state: 'released' })).toThrow(/effective date/i);
  });

  it('permits release facts to change without changing the approved methodology', () => {
    expect(() => assertReleaseTransition(candidate, released)).not.toThrow();
  });

  it('requires the next public release when a frozen field changes during release', () => {
    const changed = {
      ...released,
      requirements: [{ id: 'OE-01-01', scoring: { severity: 'critical' } }],
    };
    expect(() => assertReleaseTransition(candidate, changed)).toThrow(/next public methodology release/i);
  });

  it('gives a released regeneration one explicit remedy', () => {
    expect(releasedMethodologyChanged().message).toMatch(/next public methodology release and change record/i);
  });
});
