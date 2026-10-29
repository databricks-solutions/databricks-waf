// The public methodology identity this build may stamp on a new record.
//
// A catalogue revision says which exact scoring shape ran. A public methodology version says which
// customer release that shape belongs to. They are deliberately separate: revisions 9 through 18
// are development provenance and absence of this identity on an old record is not evidence that the
// record belonged to Version 1.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { shippedConfigDirectory } from '../shipped-config.js';

export type PublicMethodologyState = 'candidate' | 'released';

/** The immutable public identity copied into runs and final assessments. */
export interface PublicMethodologyIdentity {
  readonly publicVersion: number;
  readonly manifestDigest: string;
  readonly state: PublicMethodologyState;
  readonly effectiveDate?: string;
}

/** Release facts shown by the methodology API in addition to the identity records carry. */
export interface PublicMethodologyRelease extends PublicMethodologyIdentity {
  readonly name: string;
  readonly candidateStartedAt: string;
  readonly releaseCommit?: string;
  readonly approvedBy?: string;
}

interface ReleaseRecord extends Record<string, unknown> {
  readonly public_version?: unknown;
  readonly name?: unknown;
  readonly state?: unknown;
  readonly candidate_started_at?: unknown;
  readonly effective_date?: unknown;
  readonly release_commit?: unknown;
  readonly approved_by?: unknown;
}

interface ManifestReleaseRecord extends Record<string, unknown> {
  readonly state?: unknown;
  readonly candidate_started_at?: unknown;
  readonly effective_date?: unknown;
  readonly commit?: unknown;
  readonly approved_by?: unknown;
}

interface ManifestRecord extends Record<string, unknown> {
  readonly public_version?: unknown;
  readonly name?: unknown;
  readonly manifest_digest?: unknown;
  readonly release?: unknown;
}

function record(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is missing.`);
  return value;
}

function publicVersion(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function state(value: unknown, label: string): PublicMethodologyState {
  if (value !== 'candidate' && value !== 'released') throw new Error(`${label} must be candidate or released.`);
  return value;
}

function nullableDate(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  return nonblank(value, label);
}

function same(left: unknown, right: unknown, label: string): void {
  if (left !== right) throw new Error(`The methodology release and manifest disagree about ${label}.`);
}

/**
 * Parse the two shipped records as one release identity.
 *
 * Exported for the negative tests. Production calls it once below, so a damaged or half-updated
 * deployment fails at startup instead of stamping a plausible-looking identity assembled from two
 * records that disagree.
 */
export function publicMethodologyFrom(releaseValue: unknown, manifestValue: unknown): PublicMethodologyRelease {
  const release = object(releaseValue, 'The methodology release record') as ReleaseRecord;
  const manifest = object(manifestValue, 'The methodology manifest') as ManifestRecord;
  const manifestRelease = object(manifest.release, 'The methodology manifest release') as ManifestReleaseRecord;

  same(release.public_version, manifest.public_version, 'the public version');
  same(release.name, manifest.name, 'the release name');
  same(release.state, manifestRelease.state, 'the release state');
  same(release.candidate_started_at, manifestRelease.candidate_started_at, 'the candidate start date');
  same(release.effective_date, manifestRelease.effective_date, 'the effective date');
  same(release.release_commit, manifestRelease.commit, 'the release source commit');
  same(release.approved_by, manifestRelease.approved_by, 'the release approver');

  const parsedState = state(release.state, 'The methodology release state');
  const effectiveDate = nullableDate(release.effective_date, 'The methodology effective date');
  const releaseCommit = nullableDate(release.release_commit, 'The methodology release source commit');
  const approvedBy = nullableDate(release.approved_by, 'The methodology release approver');
  if (parsedState === 'released' && effectiveDate == null) {
    throw new Error('A released methodology must record its effective date.');
  }
  if (parsedState === 'released' && (releaseCommit == null || approvedBy == null)) {
    throw new Error('A released methodology must record its source commit and approver.');
  }

  return {
    publicVersion: publicVersion(release.public_version, 'The public methodology version'),
    name: nonblank(release.name, 'The methodology release name'),
    manifestDigest: nonblank(manifest.manifest_digest, 'The methodology manifest digest'),
    state: parsedState,
    candidateStartedAt: nonblank(release.candidate_started_at, 'The methodology candidate start date'),
    ...(effectiveDate != null ? { effectiveDate } : {}),
    ...(releaseCommit != null ? { releaseCommit } : {}),
    ...(approvedBy != null ? { approvedBy } : {}),
  };
}

/** The public versions with a release record in `directory`, ascending. */
function versionsIn(directory: string): readonly number[] {
  const versions = readdirSync(directory)
    .map((name) => /^version-(\d+)\.release\.json$/.exec(name)?.[1])
    .filter((digits): digits is string => digits != null)
    .map(Number)
    .sort((left, right) => left - right);
  if (versions.length === 0) throw new Error('No methodology release record ships with this build.');
  return versions;
}

/**
 * Load every shipped methodology version, ascending.
 *
 * A version's file name and the version its own record claims must agree, and only the highest version
 * may still be a candidate: an older candidate would be a release that was abandoned half way, and
 * nothing could say which of the two a record stamped with it belongs to.
 */
export function shippedMethodologiesIn(directory: string): readonly PublicMethodologyRelease[] {
  const loaded = versionsIn(directory).map((version) => {
    const identity = publicMethodologyFrom(
      record(join(directory, `version-${String(version)}.release.json`)),
      record(join(directory, `version-${String(version)}.manifest.json`))
    );
    if (identity.publicVersion !== version) {
      throw new Error(`version-${String(version)}.release.json names public version ${String(identity.publicVersion)}.`);
    }
    return identity;
  });
  for (const older of loaded.slice(0, -1)) {
    if (older.state !== 'released') {
      throw new Error(`Methodology Version ${String(older.publicVersion)} is superseded but was never released.`);
    }
  }
  return loaded;
}

function load(moduleUrl: string): readonly PublicMethodologyRelease[] {
  return shippedMethodologiesIn(shippedConfigDirectory('methodology', moduleUrl));
}

/** Every public methodology version this build ships, oldest first. Older released versions stay frozen. */
export const SHIPPED_METHODOLOGIES = load(import.meta.url);

/** The highest shipped version: the one stamped on records created by this build. */
export const PUBLIC_METHODOLOGY: PublicMethodologyRelease = (() => {
  const highest = SHIPPED_METHODOLOGIES.at(-1);
  if (highest == null) throw new Error('No methodology release record ships with this build.');
  return highest;
})();
