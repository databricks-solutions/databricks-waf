// The one-way boundary between a methodology candidate and a public release.
//
// Kept separate from the generator so the refusal can be unit-tested without loading the catalogue or
// writing a 184-requirement manifest. The generator remains the only writer and calls these guards before
// it changes the released file.

type JsonObject = Record<string, unknown>;

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
  const release = object(releaseValue, 'The Methodology Version 1 release record');
  if (release.state !== 'released') throw new Error('Methodology Version 1 must be marked released.');

  const effectiveDate = nonblank(release.effective_date, 'The Methodology Version 1 effective date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    throw new Error('The Methodology Version 1 effective date must use YYYY-MM-DD.');
  }

  const commit = nonblank(release.release_commit, 'The Methodology Version 1 source commit');
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('The Methodology Version 1 source commit must be a full Git SHA.');
  }
  nonblank(release.approved_by, 'The Methodology Version 1 approver');
}

export function assertReleaseTransition(currentValue: unknown, releasedValue: unknown): void {
  const currentRelease = releaseOf(currentValue, 'The current Methodology Version 1 manifest');
  const releasedRelease = releaseOf(releasedValue, 'The released Methodology Version 1 manifest');
  if (currentRelease.state !== 'candidate' || releasedRelease.state !== 'released') {
    throw new Error('The release command only permits a candidate-to-released transition.');
  }

  if (canonical(fixedMethodology(currentValue)) !== canonical(fixedMethodology(releasedValue))) {
    throw new Error(
      'Methodology Version 1 changed while it was being released. Restore the approved candidate or open the next public methodology release.'
    );
  }
}

export function releasedMethodologyChanged(): Error {
  return new Error(
    'Methodology Version 1 is released and frozen. Restore its released fields or open the next public methodology release and change record.'
  );
}
