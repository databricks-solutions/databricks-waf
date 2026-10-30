// The one-way boundary between a methodology candidate and a public release.
//
// Kept separate from the generator so the refusal can be unit-tested without loading the catalogue or
// writing a 184-requirement manifest. The generator remains the only writer and calls these guards before
// it changes the released file.
//
// A released version is frozen against a digest pinned in source, not against what the generator produces
// today. Comparing only with the generator's output lets a release record be flipped to candidate, the
// manifest regenerated from changed code, and the record flipped back: the file then agrees with the code
// and the freeze passes. A pin is a fixed point that regenerating cannot move.

import { createHash } from 'node:crypto';

type JsonObject = Record<string, unknown>;

/**
 * The manifest digest of every released public methodology version, keyed by version number.
 *
 * A version is added here in the same change that releases it and is never edited afterwards. Fixing a
 * released methodology means opening the next public version, not moving its pin.
 */
export const RELEASED_MANIFEST_DIGESTS: Readonly<Record<number, string>> = {
  1: 'sha256:30d26e28904afb7e2c95799daef7ee26219c1461728ded11f514435394c99761',
};

function object(value: unknown, label: string): JsonObject {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value as JsonObject;
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is missing.`);
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value != null && typeof value === 'object') {
    const entries = Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The digest a manifest carries: its canonical content, without the digest field itself. */
export function manifestDigestOf(manifest: unknown): string {
  const { manifest_digest: _digest, ...content } = object(manifest, 'The methodology manifest');
  return `sha256:${createHash('sha256').update(canonical(content)).digest('hex')}`;
}

function releaseOf(manifest: unknown, label: string): JsonObject {
  return object(object(manifest, label).release, `${label} release`);
}

function fixedMethodology(manifest: unknown): unknown {
  const { manifest_digest: _digest, release, ...root } = object(manifest, 'The methodology manifest');
  const {
    state: _state,
    effective_date: _effectiveDate,
    commit: _commit,
    approved_by: _approvedBy,
    ...fixedRelease
  } = object(release, 'The methodology manifest release');
  return { ...root, release: fixedRelease };
}

export function assertReleasedMetadata(releaseValue: unknown): void {
  const release = object(releaseValue, 'The methodology release record');
  const name =
    typeof release.public_version === 'number'
      ? `Methodology Version ${String(release.public_version)}`
      : 'Methodology Version';
  if (release.state !== 'released') throw new Error(`${name} must be marked released.`);

  const effectiveDate = nonblank(release.effective_date, `The ${name} effective date`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    throw new Error(`The ${name} effective date must use YYYY-MM-DD.`);
  }

  const commit = nonblank(release.release_commit, `The ${name} source commit`);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`The ${name} source commit must be a full Git SHA.`);
  }
  nonblank(release.approved_by, `The ${name} approver`);
}

/**
 * Require the release record and manifest of every pinned version to be present.
 *
 * `fileNames` are the entries of the methodology directory. A pin is only checked against files that
 * exist, so removing a released version's files would otherwise leave nothing to compare and the pin
 * would never be consulted.
 */
export function assertPinnedVersionsShip(
  fileNames: readonly string[],
  pins: Readonly<Record<number, string>> = RELEASED_MANIFEST_DIGESTS
): void {
  const present = new Set(fileNames);
  for (const version of Object.keys(pins).map(Number)) {
    for (const kind of ['release', 'manifest']) {
      const file = `version-${String(version)}.${kind}.json`;
      if (!present.has(file)) {
        throw new Error(
          `Methodology Version ${String(version)} is released and pinned, but ${file} is missing. Restore the released file.`
        );
      }
    }
  }
}

/**
 * Hold a released version to its pinned digest.
 *
 * `state` is what the release record says, `committed` is the manifest file as committed. Returns
 * quietly for a candidate with no pin, which the generator compares with the executable contracts instead.
 * Nothing here reads Git history, because CI checks out a shallow clone.
 */
export function assertFrozenAgainstPin(
  version: number,
  state: unknown,
  committed: unknown,
  pins: Readonly<Record<number, string>> = RELEASED_MANIFEST_DIGESTS
): void {
  const pin = pins[version];
  if (pin == null) {
    if (state === 'released') {
      throw new Error(
        `Methodology Version ${String(version)} is marked released but has no pinned digest. Pin the released manifest digest in methodology-release-policy.ts in the change that releases it.`
      );
    }
    return;
  }

  if (state !== 'released') throw releasedMethodologyChanged(version);

  const stored = object(committed, `The Methodology Version ${String(version)} manifest`).manifest_digest;
  if (stored !== manifestDigestOf(committed)) {
    throw new Error(
      `The Methodology Version ${String(version)} manifest digest does not describe its own content. Restore the released file.`
    );
  }
  if (stored !== pin) throw releasedMethodologyChanged(version);
}

export function assertReleaseTransition(currentValue: unknown, releasedValue: unknown): void {
  const currentRelease = releaseOf(currentValue, 'The current methodology manifest');
  const releasedRelease = releaseOf(releasedValue, 'The released methodology manifest');
  if (currentRelease.state !== 'candidate' || releasedRelease.state !== 'released') {
    throw new Error('The release command only permits a candidate-to-released transition.');
  }

  if (canonical(fixedMethodology(currentValue)) !== canonical(fixedMethodology(releasedValue))) {
    throw new Error(
      'The methodology changed while it was being released. Restore the approved candidate or open the next public methodology release.'
    );
  }
}

export function releasedMethodologyChanged(version = 1): Error {
  return new Error(
    `Methodology Version ${String(version)} is released and frozen. Restore its released fields or open the next public methodology release and change record.`
  );
}
