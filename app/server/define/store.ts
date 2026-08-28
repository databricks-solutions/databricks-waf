// Where assessment definitions are kept.
//
// The same two-implementation shape the other stores use, and the same reason: an install with no
// database bound has to work and has to say what it cannot do rather than silently forget it.
//
// What differs from the attestation and decision stores is the shape of the thing being stored.
// Those are flat append-only logs — one record per event, superseding recorded by naming the record
// replaced. A definition is an aggregate with an append-only list inside it, and the interface here
// is built so that the append is the only write a version ever takes part in.
//
// Concretely: there is no operation that stores a definition and its versions together after the
// first. Revising appends one version, identified by its number, and a version number that is
// already taken is a conflict rather than an overwrite. That is what makes two people editing the
// same assessment at once produce an error for the loser instead of a silently discarded revision —
// the failure mode of storing the whole aggregate on every write, where a stale read followed by a
// write drops whatever happened in between and nothing anywhere says so.

import type { AssessmentDefinition, DefinitionVersion } from './definition.js';
import { currentVersion } from './definition.js';

/**
 * Somebody else revised this definition first.
 *
 * Its own error because the caller can do something specific about it — re-read, show what changed,
 * and let the author decide — which is not true of a failed connection.
 */
export class DefinitionConflict extends Error {
  constructor(
    readonly definitionId: string,
    readonly version: number,
  ) {
    super(
      `Version ${String(version)} of assessment ${definitionId} already exists, so somebody revised it ` +
        'first. Re-read it and decide against what they changed.',
    );
  }
}

export interface DefinitionStore {
  /** True when definitions survive a process restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;
  /** Every definition, archived ones included, each with its full version history. */
  all(): Promise<readonly AssessmentDefinition[]>;
  get(id: string): Promise<AssessmentDefinition | undefined>;
  /** Stores a new definition and its first version. */
  create(definition: AssessmentDefinition): Promise<void>;
  /** Appends one version. Refuses a number already stored rather than replacing it. */
  appendVersion(id: string, version: DefinitionVersion): Promise<void>;
  /** Marks a definition closed to new runs. Idempotent, and never removes anything. */
  archive(id: string, at: Date): Promise<void>;
  /** Reopens an archived definition to new runs. Idempotent, and never touches its versions. */
  unarchive(id: string): Promise<void>;
}

/** Newest first by when the definition was created, which is its first version's date. */
export function newestFirst(definitions: readonly AssessmentDefinition[]): AssessmentDefinition[] {
  return [...definitions].sort((a, b) => createdAt(b).getTime() - createdAt(a).getTime());
}

function createdAt(definition: AssessmentDefinition): Date {
  return definition.versions[0]?.createdAt ?? currentVersion(definition).createdAt;
}

/** The definitions a new run may be started from: everything not archived. */
export function selectable(definitions: readonly AssessmentDefinition[]): AssessmentDefinition[] {
  return newestFirst(definitions.filter((definition) => definition.archivedAt == null));
}

export class InMemoryDefinitionStore implements DefinitionStore {
  readonly durable = false;

  private readonly definitions = new Map<string, AssessmentDefinition>();

  all(): Promise<readonly AssessmentDefinition[]> {
    return Promise.resolve(newestFirst([...this.definitions.values()]));
  }

  get(id: string): Promise<AssessmentDefinition | undefined> {
    return Promise.resolve(this.definitions.get(id));
  }

  create(definition: AssessmentDefinition): Promise<void> {
    const existing = this.definitions.get(definition.id);
    if (existing != null) {
      // Same conflict the database's primary key raises, so a caller written against one
      // implementation behaves the same against the other.
      return Promise.reject(new DefinitionConflict(definition.id, currentVersion(definition).version));
    }
    this.definitions.set(definition.id, definition);
    return Promise.resolve();
  }

  appendVersion(id: string, version: DefinitionVersion): Promise<void> {
    const existing = this.definitions.get(id);
    if (existing == null) return Promise.reject(new Error(`No assessment ${id} to revise.`));
    if (existing.versions.some((one) => one.version === version.version)) {
      return Promise.reject(new DefinitionConflict(id, version.version));
    }
    this.definitions.set(id, { ...existing, versions: [...existing.versions, version] });
    return Promise.resolve();
  }

  archive(id: string, at: Date): Promise<void> {
    const existing = this.definitions.get(id);
    if (existing == null) return Promise.reject(new Error(`No assessment ${id} to archive.`));
    if (existing.archivedAt != null) return Promise.resolve();
    this.definitions.set(id, { ...existing, archivedAt: at });
    return Promise.resolve();
  }

  unarchive(id: string): Promise<void> {
    const existing = this.definitions.get(id);
    if (existing == null) return Promise.reject(new Error(`No assessment ${id} to reopen.`));
    if (existing.archivedAt == null) return Promise.resolve();
    // Deleted rather than set to undefined, so `'archivedAt' in definition` agrees with the database,
    // where the column goes back to null and the row reads as one that was never archived.
    const { archivedAt: _was, ...rest } = existing;
    this.definitions.set(id, rest);
    return Promise.resolve();
  }
}
