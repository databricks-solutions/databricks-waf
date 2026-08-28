// An assessment part-written, and what has happened to the world since.
//
// Writing a definition takes more than one sitting. It asks for a name, a purpose, the people
// accountable, which workspaces, how far back, which pillars — and the answers to several of those
// are not the author's to give. "Which workspaces" is a question for whoever owns the estate, and
// the honest thing for an author to do at that point is stop and go and ask. Today stopping loses
// everything typed, because the form holds its fields in a component and a reload is a new
// component. So the app teaches authors to finish in one go with whatever they can guess, which is
// how a definition ends up naming a scope nobody agreed to.
//
// A draft fixes that by being stored. What makes it worth a domain file rather than a column of
// JSON is not the storing, though — it is the two things that can be wrong when the author comes
// back, and both of them are silent.
//
// The first is that a draft is incomplete by construction, so `normalise` cannot be pointed at it.
// A draft has to be able to hold a lookback of nothing and a name of nothing without that being an
// error, and it has to be able to say which of those still stand between it and being a definition.
// That is `troubles`, and it is what the wizard reads to decide where to put the author back.
//
// The second is the dangerous one. A revision draft records the version it was started from. If
// somebody else revises the assessment while the draft sits unfinished, then confirming it would
// compute its change against a version that is no longer current — and the routes already refuse
// that, with a 409, after the author has re-read five steps and pressed the last button. `standing`
// exists so the refusal arrives first, on the way in, naming who changed it. The same check catches
// the assessment having been archived, and the assessment having gone from the store entirely.
//
// Nothing here is a cursor. Where the author lands is derived from which steps do not yet hold what
// they need, exactly as the answers walk derives its position from which answers no longer count
// (ADR 0036) — so a draft edited from a second browser resumes correctly rather than resuming where
// the first browser had got to.

import { MAX_LOOKBACK_DAYS, MIN_LOOKBACK_DAYS, currentVersion, type AssessmentDefinition } from './definition.js';

/**
 * The steps of the setup, in the order they are asked.
 *
 * `sources` and `policies` come after scope because both are consequences of it: which system
 * tables get read follows from which pillars are in the assessment, and the rules the result will
 * be judged by are worth reading once the reader knows what is being judged. `confirm` is last and
 * is the only step that writes anything.
 */
export const SETUP_STEPS = ['purpose', 'scope', 'sources', 'targets', 'policies', 'confirm'] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * A target as an author part-way through setting one.
 *
 * Looser than `PillarTarget` for the same reason `DraftScope` is looser than `DefinitionScope`: a row
 * with a pillar and no date yet is a legitimate state for a draft and an error for a definition. The
 * date is a string here because that is what a date field gives, and because a draft's job is to hold
 * what was typed rather than to have opinions about it.
 */
export interface DraftTarget {
  readonly pillar: string;
  readonly atLeast?: number;
  /** A day, as `YYYY-MM-DD`. Read as UTC when it becomes a definition, so the day cannot shift. */
  readonly by?: string;
}

/**
 * Scope as an author part-way through choosing it.
 *
 * Looser than `DefinitionScope`: `selected` with no ids yet is a legitimate state for a draft and
 * an error for a definition, so the two cannot be the same type. Collapsing them and treating the
 * empty list as account reach would silently widen a scope somebody had started to narrow.
 */
export interface DraftScope {
  readonly kind: 'account' | 'selected';
  readonly workspaceIds?: readonly string[];
}

/**
 * What one author has written down about one assessment, so far.
 *
 * Keyed on the author and the target, so revising two assessments at once does not have the two
 * drafts overwrite each other, and so nobody else can read what a colleague is part-way through
 * proposing. Every content field is optional and absent means untouched — with one exception worth
 * naming, because it is the field where absence already means something: `pillars` absent on a
 * *definition* means every pillar, so a draft that has not been to the sources step and a draft
 * whose author chose everything are the same draft. That is correct rather than a limitation. The
 * two produce the same assessment, and a distinction that changes no outcome is not worth a column.
 */
export interface SetupDraft {
  /** Whose it is. Never taken from a request body — see the routes. */
  readonly author: string;
  /** The assessment being revised, or absent when this is a new one. */
  readonly definitionId?: string;
  /**
   * The version the revision was started from.
   *
   * Present whenever `definitionId` is, and the reason `standing` can tell a stale draft from a
   * current one. A draft carrying an id and no version cannot be checked against anything, so it is
   * treated as stale rather than as safe.
   */
  readonly fromVersion?: number;
  readonly name?: string;
  readonly purpose?: string;
  readonly owners?: readonly string[];
  readonly scope?: DraftScope;
  readonly lookbackDays?: number;
  readonly pillars?: readonly string[];
  /**
   * What this assessment is to commit to, as far as it has been decided.
   *
   * Absent and empty mean the same thing here, unlike `pillars`: nothing has been committed to, which
   * is a complete answer rather than a step left undone. Targets are optional on a definition, so an
   * author who never opens this step has not left anything unfinished.
   */
  readonly targets?: readonly DraftTarget[];
  /** What the author will say changed, on a revision. */
  readonly note?: string;
  readonly savedAt: Date;
}

/** A step that does not yet hold what it needs, and the sentence saying so. */
export interface Trouble {
  readonly step: SetupStep;
  readonly trouble: string;
}

/**
 * What still stands between this draft and an assessment, step by step.
 *
 * Every entry is a sentence an author can act on rather than a field name, because this is what
 * the wizard's contents strip shows against each step and "name: required" tells somebody who has
 * been away for a week nothing they did not already know.
 *
 * The lookback is checked against the same bounds `normalise` enforces rather than against looser
 * ones. A draft that passes here and is then refused on confirm would be the worst of both: the
 * author gets to the end before finding out, which is the thing a draft exists to stop.
 */
export function troubles(draft: SetupDraft): readonly Trouble[] {
  const found: Trouble[] = [];

  if ((draft.name ?? '').trim() === '') {
    found.push({ step: 'purpose', trouble: 'This assessment has no name yet, so nobody could ask for it by one.' });
  }

  if (draft.scope == null) {
    found.push({
      step: 'scope',
      trouble: 'Nothing says which workspaces this assessment is of — the whole account, or a set that was chosen.',
    });
  } else if (draft.scope.kind === 'selected' && (draft.scope.workspaceIds ?? []).length === 0) {
    found.push({
      step: 'scope',
      trouble: 'The scope narrows to chosen workspaces and none are chosen, so this assessment would measure nothing.',
    });
  }

  if (draft.lookbackDays == null) {
    found.push({ step: 'scope', trouble: 'Nothing says how far back this assessment looks.' });
  } else if (
    !Number.isInteger(draft.lookbackDays) ||
    draft.lookbackDays < MIN_LOOKBACK_DAYS ||
    draft.lookbackDays > MAX_LOOKBACK_DAYS
  ) {
    found.push({
      step: 'scope',
      trouble:
        `A lookback of ${String(draft.lookbackDays)} days is not one the system tables can answer. It has to be a ` +
        `whole number between ${String(MIN_LOOKBACK_DAYS)} and ${String(MAX_LOOKBACK_DAYS)}.`,
    });
  }

  if (draft.pillars != null && draft.pillars.length === 0) {
    found.push({
      step: 'sources',
      trouble: 'No pillars are in the assessment. Choose at least one, or choose them all and the list goes away.',
    });
  }

  found.push(...targetTroubles(draft));

  return found;
}

/**
 * What is unfinished about the commitments, if anything.
 *
 * Nothing at all when there are none, which is the ordinary case: a target is optional, so an author
 * who never opened this step has left nothing outstanding and must not be told they have. What is
 * reported is a target somebody *started* — a score with no date, a date with no score — because that
 * is a commitment which would be silently dropped on confirmation, and the author believes they set it.
 *
 * A target for a pillar the assessment no longer covers is reported here rather than only refused on
 * confirmation, and it is the trouble most likely to be reached by accident: choosing four pillars on
 * the previous step after setting six targets is two ordinary edits that contradict each other.
 */
function targetTroubles(draft: SetupDraft): readonly Trouble[] {
  const started = (draft.targets ?? []).filter(
    (target) => target.pillar.trim() !== '' && (target.atLeast != null || (target.by ?? '') !== '')
  );
  if (started.length === 0) return [];

  const found: Trouble[] = [];

  const half = started.filter((target) => target.atLeast == null || (target.by ?? '') === '');
  if (half.length > 0) {
    found.push({
      step: 'targets',
      trouble:
        `${named(half)} ${half.length === 1 ? 'has' : 'have'} half a target: a commitment needs both a score and ` +
        'the date it is to be reached by. Fill in the rest, or clear it.',
    });
  }

  const outside =
    draft.pillars == null
      ? []
      : started.filter((target) => !draft.pillars?.includes(target.pillar));
  if (outside.length > 0) {
    found.push({
      step: 'targets',
      trouble:
        `${named(outside)} ${outside.length === 1 ? 'is' : 'are'} not in this assessment, so a target for ` +
        `${outside.length === 1 ? 'it' : 'them'} could never be reported against. Add the pillar back, or clear ` +
        'the target.',
    });
  }

  const seen = new Set<string>();
  const twice = started.filter((target) => {
    const pillar = target.pillar.trim();
    const already = seen.has(pillar);
    seen.add(pillar);
    return already;
  });
  if (twice.length > 0) {
    found.push({
      step: 'targets',
      trouble: `${named(twice)} has more than one target, and a pillar has one. Remove the one that is not meant.`,
    });
  }

  return found;
}

function named(targets: readonly DraftTarget[]): string {
  const pillars = [...new Set(targets.map((target) => target.pillar.trim()))];
  if (pillars.length > 3) return `${String(pillars.length)} pillars`;
  if (pillars.length === 1) return pillars[0] ?? '';
  return `${pillars.slice(0, -1).join(', ')} and ${pillars.at(-1) ?? ''}`;
}

export function ready(draft: SetupDraft): boolean {
  return troubles(draft).length === 0;
}

/**
 * Where to put the author back: the first step that is not finished, or the confirmation.
 *
 * Derived rather than stored, which is what makes it right after a colleague archives the
 * assessment or after the author fixed the scope from a phone. A stored position would have been
 * whatever was true when it was written, and the wizard would have opened on a step with nothing
 * left to do on it.
 *
 * The policies step never appears here, because nothing on it is the author's to fill in. It is
 * reachable from the contents strip like every other step, and a reader who wants to see the rules
 * before confirming can go and read them — but being taken to a page with no field on it, and told
 * that is where the work stopped, would be a lie about why they are there.
 */
export function resumeAt(draft: SetupDraft): SetupStep {
  const found = troubles(draft);
  for (const step of SETUP_STEPS) {
    if (found.some((one) => one.step === step)) return step;
  }
  return 'confirm';
}

/**
 * Whether the assessment this draft revises is still the one it was started against.
 *
 * `new` is a draft of an assessment that does not exist yet, and has nothing to be stale against.
 * The other four are all reasons a confirmation would fail or would do damage, and each is a
 * different thing to tell the author, which is why this is not a boolean.
 */
export type DraftStanding = 'new' | 'current' | 'superseded' | 'archived' | 'gone';

export interface Standing {
  readonly standing: DraftStanding;
  /** Absent only when the standing is `new` or `current`, where there is nothing to warn about. */
  readonly warning?: string;
}

/**
 * The draft held against the assessment as it is now.
 *
 * Called on the way into the wizard rather than on the way out. Both orders refuse the same
 * revisions; only this one refuses them before the author has spent an evening re-reading their own
 * scope.
 */
export function standingOf(draft: SetupDraft, definition: AssessmentDefinition | undefined): Standing {
  if (draft.definitionId == null) return { standing: 'new' };

  if (definition == null) {
    return {
      standing: 'gone',
      warning:
        'The assessment this was a revision of is no longer in the store, so there is nothing to revise. That ' +
        'happens if it was removed directly in the database, and it also happens if this installation lost the ' +
        'database it was keeping definitions in — the two cannot be told apart from here. What you wrote is ' +
        'still below, and it can be saved as a new assessment.',
    };
  }

  if (definition.archivedAt != null) {
    return {
      standing: 'archived',
      warning:
        `"${currentVersion(definition).attribution.name}" was archived, so it cannot take another version. What ` +
        'you wrote is still below, and it can be saved as a new assessment instead.',
    };
  }

  const current = currentVersion(definition);
  if (draft.fromVersion !== current.version) {
    const from = draft.fromVersion == null ? 'an unrecorded version' : `version ${String(draft.fromVersion)}`;
    return {
      standing: 'superseded',
      warning:
        `This was started from ${from}, and version ${String(current.version)} is now current — ` +
        `${current.createdBy} changed it. Read what they changed before confirming, because saving this would ` +
        'be a decision made against a copy that no longer exists.',
    };
  }

  return { standing: 'current' };
}

export class SetupError extends Error {}
