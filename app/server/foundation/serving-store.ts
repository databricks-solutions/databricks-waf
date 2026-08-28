// Where a serving declaration is kept, and what one looks like once somebody has made it.
//
// [`serving-asset.ts`](serving-asset.ts) says what a definition is and refuses one that would classify
// an asset by its name. This says how a customer's definition survives a restart, and it is the same
// two-implementation shape as every other store here: a durable one, and an in-memory fallback the UI
// warns about rather than a reasonable place to run from.
//
// Append-only, and for a stronger reason than the notes store has. A readiness reading is a reading
// *of a declaration* — every dimension is a share of the population that declaration selects — so a
// declaration that could be edited in place would silently re-date every reading ever taken against
// it. A revision is a new row with the next version, the fingerprint travels on the outcome, and two
// readings can therefore say whether they were taken of the same thing.

import type { ServingDefinition, ServingDraft } from './serving-asset.js';
import { defineServing } from './serving-asset.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { inScope } from '../store/assessment-scope.js';

/** One declaration, as made: who made it, when, and what it says. */
export interface ServingDeclaration {
  /** `serving-<version>`, minted by the caller. Unique per assessment. */
  readonly id: string;
  /** 1 for the first, one higher for each revision. `declare` refuses one that is not the next. */
  readonly version: number;
  readonly declaredAt: Date;
  readonly declaredBy: string;
  readonly definition: ServingDefinition;
  /** The assessment this belongs to, where the install runs more than one. */
  readonly definitionId?: string;
}

export class ServingVersionError extends Error {}

export interface ServingStore {
  /** True when a declaration survives a process restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;

  /**
   * Appends a declaration, or refuses one whose version is not the next.
   *
   * Refused rather than accepted, which is the opposite of what the notes store does with a repeated
   * id, and the difference is what the record is for. A note arriving twice is one note; a declaration
   * arriving at a version that already exists is two people declaring different populations and one of
   * them not knowing. The refusal names the version that is current, so the caller can re-read and
   * decide, which is the only thing anybody could do with the news.
   */
  declare(declaration: ServingDeclaration): Promise<void>;

  /** The newest declaration, or undefined where nobody has made one. */
  current(scope?: AssessmentScope): Promise<ServingDeclaration | undefined>;

  /** Every declaration, newest first, because the question is what changed and when. */
  history(scope?: AssessmentScope): Promise<readonly ServingDeclaration[]>;
}

/**
 * The next declaration over a draft, checked and numbered.
 *
 * Here rather than in the route so the two stores and the route agree on what "the next one" means:
 * the version is read from what is stored rather than sent by the caller. A caller that sent its own
 * would be sending a number it read some time ago, which is the lost-update it cannot see.
 */
export function nextDeclaration(
  draft: ServingDraft,
  previous: ServingDeclaration | undefined,
  by: string,
  at: Date,
  definitionId?: string,
): ServingDeclaration {
  const version = (previous?.version ?? 0) + 1;
  return {
    id: `serving-${String(version)}`,
    version,
    declaredAt: at,
    declaredBy: by,
    definition: defineServing(draft, version),
    ...(definitionId != null ? { definitionId } : {}),
  };
}

/**
 * A stored row back into a declaration, or undefined where it cannot be trusted.
 *
 * The definition is rebuilt through `defineServing` rather than taken from the row, and then the
 * fingerprint it computes is compared with the stored one. That is two checks in one: a row edited in
 * the database, and a row written by a build whose rules have since changed. Both read as unreadable,
 * because a readiness outcome carries this fingerprint as the thing it is a reading of, and a
 * definition that no longer means what its fingerprint says is worse than no definition at all.
 */
export function reviveDeclaration(raw: unknown): ServingDeclaration | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as ServingDeclaration & { declaredAt: string | Date };
  if (typeof candidate.id !== 'string' || typeof candidate.declaredBy !== 'string') return undefined;
  if (!Number.isInteger(candidate.version) || candidate.version < 1) return undefined;

  const at = new Date(candidate.declaredAt);
  if (Number.isNaN(at.getTime())) return undefined;

  const stored = candidate.definition;
  if (stored == null || typeof stored !== 'object') return undefined;

  let definition: ServingDefinition;
  try {
    definition = defineServing(stored, candidate.version);
  } catch {
    return undefined;
  }
  if (definition.fingerprint !== stored.fingerprint) return undefined;

  return {
    id: candidate.id,
    version: candidate.version,
    declaredAt: at,
    declaredBy: candidate.declaredBy,
    definition,
    ...(typeof candidate.definitionId === 'string' ? { definitionId: candidate.definitionId } : {}),
  };
}

/** Newest first, by version, which is the order a history is read in and the order `current` needs. */
export function newestFirst(declarations: readonly ServingDeclaration[]): readonly ServingDeclaration[] {
  return [...declarations].sort((one, other) => other.version - one.version);
}

/** Declarations in memory, for a demo and for tests. */
export class InMemoryServingStore implements ServingStore {
  readonly durable = false;

  private readonly declarations: ServingDeclaration[] = [];

  declare(declaration: ServingDeclaration): Promise<void> {
    const clash = this.declarations.find(
      (one) => one.version === declaration.version && one.definitionId === declaration.definitionId,
    );
    if (clash != null) {
      return Promise.reject(
        new ServingVersionError(
          `Version ${String(declaration.version)} of the serving declaration already exists. Re-read the ` +
            'current one and declare the next.',
        ),
      );
    }
    this.declarations.push(declaration);
    return Promise.resolve();
  }

  current(scope?: AssessmentScope): Promise<ServingDeclaration | undefined> {
    return Promise.resolve(newestFirst(this.mine(scope))[0]);
  }

  history(scope?: AssessmentScope): Promise<readonly ServingDeclaration[]> {
    return Promise.resolve(newestFirst(this.mine(scope)));
  }

  private mine(scope?: AssessmentScope): readonly ServingDeclaration[] {
    return this.declarations.filter((one) => inScope(one.definitionId, scope));
  }
}
