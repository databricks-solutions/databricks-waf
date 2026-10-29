import { describe, expect, it } from 'vitest';
import {
  RELEASED_MANIFEST_DIGESTS,
  assertFrozenAgainstPin,
  assertReleasedMetadata,
  assertReleaseTransition,
  manifestDigestOf,
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

describe('the pinned digests of released methodologies', () => {
  const { manifest_digest: _unsealed, ...releasedContent } = released;
  const seal = (content: Record<string, unknown>): Record<string, unknown> => ({
    ...content,
    manifest_digest: manifestDigestOf(content),
  });
  const frozen = seal(releasedContent);
  const pins = { 1: String(frozen.manifest_digest) };

  it('pins Methodology Version 1 to the manifest that was released', () => {
    expect(RELEASED_MANIFEST_DIGESTS[1]).toBe(
      'sha256:30d26e28904afb7e2c95799daef7ee26219c1461728ded11f514435394c99761'
    );
  });

  it('accepts a released manifest whose content digest is the pin', () => {
    expect(() => assertFrozenAgainstPin(1, 'released', frozen, pins)).not.toThrow();
  });

  it('refuses a stored digest that does not describe the manifest beside it', () => {
    const forged = { ...frozen, requirements: [{ id: 'OE-01-01', scoring: { severity: 'critical' } }] };
    expect(() => assertFrozenAgainstPin(1, 'released', forged, pins)).toThrow(/does not describe its own content/i);
  });

  it('refuses the state-flip sequence: flip to candidate, regenerate, flip back', () => {
    // 1. The record is flipped to candidate, so the generator stops treating it as frozen.
    // 2. The manifest is regenerated from changed code and sealed with its own, new digest.
    const regenerated = seal({
      ...releasedContent,
      requirements: [{ id: 'OE-01-01', scoring: { severity: 'critical' } }],
      release: { ...releasedContent.release, state: 'candidate', effective_date: null },
    });
    expect(() => assertFrozenAgainstPin(1, 'candidate', regenerated, pins)).toThrow(/released and frozen/i);
    // 3. The record is flipped back to released, and the generator now agrees with the regenerated file.
    const { manifest_digest: _stale, ...regeneratedContent } = regenerated;
    const flippedBack = seal({ ...regeneratedContent, release: releasedContent.release });
    expect(() => assertFrozenAgainstPin(1, 'released', flippedBack, pins)).toThrow(/released and frozen/i);
  });

  it('refuses a version recorded as released that has no pin', () => {
    expect(() => assertFrozenAgainstPin(2, 'released', frozen, pins)).toThrow(/no pinned digest/i);
  });

  it('leaves a candidate with no pin to the generator comparison', () => {
    expect(() => assertFrozenAgainstPin(2, 'candidate', candidate, pins)).not.toThrow();
  });
});
