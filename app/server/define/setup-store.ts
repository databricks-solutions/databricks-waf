// Where an unfinished assessment is kept.
//
// The same two implementations the other stores have, for the same reason: an install with no
// database has to work, and has to say that a draft will not survive a deploy rather than lose one
// without mentioning it.
//
// Two things differ from the definition store next door, and both follow from a draft being one
// person's own scratch rather than a record anybody will be held to.
//
// It is keyed and overwritten rather than appended. `assessment_definition_versions` refuses a
// second row with the same number because two authors racing on a revision must not silently
// discard each other's work. Here there is only ever one author — the key includes them — so the
// second write is the same person having typed more, and refusing it would mean the wizard could
// not save twice. Last write wins is the correct rule for exactly this shape and the wrong rule one
// table over, which is why it is stated rather than inherited.
//
// It is deleted. Definitions are archived and never removed, because a finished run points at a
// version and a dangling reference reads worse than a closed one. Nothing points at a draft: it is
// either confirmed, at which point it has become a version and has nothing left to say, or it is
// abandoned, at which point keeping it means the wizard offers to resume something the author
// decided against.

import type { SetupDraft } from './setup.js';

export interface SetupDraftStore {
  /** True when an unfinished assessment survives a restart. Surfaced to the author, never assumed. */
  readonly durable: boolean;
  /** This author's draft for this target, if they have one. */
  get(author: string, definitionId?: string): Promise<SetupDraft | undefined>;
  /**
   * Everything this author has unfinished, newest first, so the page can offer to pick one up.
   *
   * Deliberately unfiltered by assessment: this is the author's draft list, and a draft for a
   * second assessment is exactly what the list is for. `get` and `save` stay keyed on the pair
   * `(author, definition_id)`. `42c` records that reading rather than leaving both methods as they
   * were, which would have been one scoped and one not with nothing saying which was intended.
   */
  mine(author: string): Promise<readonly SetupDraft[]>;
  /** Stores it, replacing whatever this author last wrote for the same target. */
  save(draft: SetupDraft): Promise<void>;
  /** Removes it. Idempotent, because confirming and abandoning both end here. */
  discard(author: string, definitionId?: string): Promise<void>;
}

/**
 * The target half of the key, as a value a primary key can hold.
 *
 * A new assessment has no id, and a nullable column cannot be part of a primary key in Postgres, so
 * the absent id is stored as the empty string. Kept in one function used by both implementations so
 * the two cannot disagree about which draft is which — an in-memory store keying on `undefined` and
 * a database keying on `''` would behave identically until something iterated one of them.
 */
export function targetOf(definitionId?: string): string {
  return definitionId ?? '';
}

/** Newest first, which is the order somebody picking up abandoned work wants them in. */
export function newestFirst(drafts: readonly SetupDraft[]): SetupDraft[] {
  return [...drafts].sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
}

export class InMemorySetupDraftStore implements SetupDraftStore {
  readonly durable = false;

  private readonly drafts = new Map<string, SetupDraft>();

  get(author: string, definitionId?: string): Promise<SetupDraft | undefined> {
    return Promise.resolve(this.drafts.get(keyOf(author, definitionId)));
  }

  mine(author: string): Promise<readonly SetupDraft[]> {
    return Promise.resolve(newestFirst([...this.drafts.values()].filter((draft) => draft.author === author)));
  }

  save(draft: SetupDraft): Promise<void> {
    this.drafts.set(keyOf(draft.author, draft.definitionId), draft);
    return Promise.resolve();
  }

  discard(author: string, definitionId?: string): Promise<void> {
    this.drafts.delete(keyOf(author, definitionId));
    return Promise.resolve();
  }
}

/**
 * The composite key as one string.
 *
 * The separator is a newline rather than a colon, because an author is an email address and a
 * definition id is a UUID and neither can contain one — where a colon appears in plenty of
 * identities and would let two different pairs collide on one key.
 */
function keyOf(author: string, definitionId?: string): string {
  return `${author}\n${targetOf(definitionId)}`;
}
