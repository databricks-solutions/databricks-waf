// The sentences the readiness page renders, and what each of them may not say.
//
// Beside `schedule-language.ts` and for its reason: a sentence a reader acts on is reviewed next to
// the rule it obeys, and one composed inline in JSX is reviewed as markup. What this file adds to the
// server's own wording — the dimension labels, and what each dimension asks, which are in
// `foundation/readiness-language.ts` because they describe fields the server read — is the wording
// about *the reading itself*: how much of the declaration was covered, what a standing means, and
// what a missing number is missing for.
//
// Three rules, each of which a draft of this file broke.
//
//   * **A share is a share of the denominator beside it, never of the population.** Every sentence
//     naming a number here names what it is out of in the same sentence. `45a` measured the same
//     description coverage at 13.5% and 34.1% on one estate from two correctly-computed statements
//     over different populations, and a percentage with no denominator is that pair with the
//     disagreement removed.
//   * **Unmeasured is not a low score.** It is the app not having read something, and the page says
//     which thing. A sentence that shaded it towards "poor" would teach readers to read their own
//     blind spots as findings, which is the badge module's rule stated for prose.
//   * **Nothing here totals anything.** There is no sentence summing the eight, and there is no
//     "overall" word for a page to reach for. If one is wanted later, it is a measurement somebody
//     has to defend, not a phrase.

import { CheckCircle2, CircleDashed, CircleHelp, XCircle, type LucideIcon } from 'lucide-react';
import type { FoundationReadiness, ReadinessDimension } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';

export interface StandingPresentation {
  readonly label: string;
  readonly tone: Tone;
  readonly Icon: LucideIcon;
}

/**
 * The four standings, in a word and a shape.
 *
 * `unmeasured` is neutral rather than amber, which is the badge module's rule and matters more here
 * than anywhere else in the app: six of the eight dimensions read a single statement, so one
 * unreadable statement colours most of this page at once, and an amber wash would report the estate
 * for a grant the app is missing.
 */
const STANDINGS: Readonly<Record<ReadinessDimension['standing'], StandingPresentation>> = {
  ready: { label: 'Ready', tone: 'success', Icon: CheckCircle2 },
  partial: { label: 'Part way', tone: 'warning', Icon: CircleDashed },
  short: { label: 'Short', tone: 'danger', Icon: XCircle },
  unmeasured: { label: 'Not read', tone: 'neutral', Icon: CircleHelp },
};

export function standingPresentation(standing: ReadinessDimension['standing']): StandingPresentation {
  return STANDINGS[standing];
}

/** A share as a whole percentage, or a dash where there is none. Never rounded up to 100 from below. */
export function sharePhrase(share: number | null): string {
  if (share == null) return '—';
  const percent = share * 100;
  // Floored below 100 so a dimension one asset short cannot print as 100%, which is the one rounding
  // error a reader would act on: it reads as done.
  const shown = percent >= 100 ? 100 : Math.floor(percent);
  return `${String(shown)}%`;
}

/**
 * What a dimension counted, out of what.
 *
 * The denominator is in the sentence rather than beside it, because the two get separated the moment
 * a layout changes and a bare "12 of 40" is the failure at the top of this file.
 */
export function countPhrase(dimension: ReadinessDimension): string {
  const { denominator } = dimension;
  if (denominator.count === 0) {
    return `0 ${denominator.of}. Reason: ${dimension.because ?? 'nothing was available to count'}.`;
  }
  const excluded =
    denominator.excluded === 0
      ? ''
      : ` ${String(denominator.excluded)} more ${denominator.excluded === 1 ? 'is' : 'are'} out of this count: ${denominator.excludedBecause}.`;
  const unread =
    dimension.unmeasured === 0
      ? ''
      : ` ${String(dimension.unmeasured)} could not be read, and ${dimension.unmeasured === 1 ? 'is' : 'are'} not in it either.`;
  return `${String(dimension.met)} of ${String(denominator.count)} ${denominator.of}.${excluded}${unread}`;
}

/** Where the two thresholds sit, said once rather than implied by a colour. */
export function bandPhrase(dimension: ReadinessDimension): string {
  const ready = Math.round(dimension.bands.ready * 100);
  const partial = Math.round(dimension.bands.partial * 100);
  return `Ready at ${String(ready)}% and above, part way from ${String(partial)}%, short below that. These two thresholds are this app's, not the platform's.`;
}

/**
 * What the page is a reading of, in one line under the title.
 *
 * Four states and they are four different pieces of news: nothing declared, nothing to read it with,
 * a declaration whose population is part of one, and a reading. Only the last is about the estate.
 */
export function readingSentence(readiness: FoundationReadiness): string {
  if (readiness.unavailable != null) return readiness.unavailable;
  if (readiness.declaration == null) {
    return (
      'Nobody has said which data this organisation serves, so there is no population to read these ' +
      'against. Until somebody does, every dimension below is unread rather than failing.'
    );
  }

  const { population, declaration } = readiness;
  const assets = `${String(population.assets)} ${population.assets === 1 ? 'relation' : 'relations'}`;
  const missing =
    population.missing === 0
      ? ''
      : ` ${String(population.missing)} named ${population.missing === 1 ? 'relation is' : 'relations are'} not in the catalogue this read saw, which is a dropped table or a grant this app does not hold.`;
  const truncated = population.truncated
    ? ' The read stopped at its row ceiling, so every share below is a share of part of what was declared.'
    : '';

  return `Version ${String(declaration.version)} of the serving declaration selects ${assets}.${missing}${truncated}`;
}

/**
 * A statement this reading cannot use, named.
 *
 * Named rather than counted, because the three are not interchangeable: the population read failing
 * leaves nothing at all, the tag read failing leaves one dimension unread, and the facts read failing
 * leaves six. A reader who knows which one it was knows what they are missing.
 *
 * The opening clause is "could not be read from" rather than "did not answer", and the difference is
 * not stylistic. A capped read answers: it returns rows and stops at its ceiling. Told that it did not
 * answer, a reader goes looking for the grant it is missing, and there is no grant missing. Which of
 * the two happened is on each entry's `kind`, so the sentence says it per statement rather than
 * choosing one verb for a mixed list.
 */
export function unreadSentence(unread: FoundationReadiness['unread']): string | undefined {
  if (unread.length === 0) return undefined;
  const named = unread
    .map(
      (one) =>
        `${one.statement} ${one.kind === 'capped' ? 'stopped at its ceiling' : 'did not answer'} (${one.because})`
    )
    .join('; ');
  return `${unread.length === 1 ? 'One statement' : `${String(unread.length)} statements`} could not be read from, so what ${unread.length === 1 ? 'it reads' : 'they read'} is reported as unread rather than as nothing found: ${named}.`;
}

/**
 * How the declaration selects what it selects, for the panel that shows what is being read.
 *
 * Both halves always, including the empty one. A declaration that names ten relations and tags none
 * is a different statement from one that tags everything certified, and a panel that showed only the
 * non-empty half would make the two look alike.
 */
export function selectionPhrases(declaration: NonNullable<FoundationReadiness['declaration']>): readonly string[] {
  const named =
    declaration.named.length === 0
      ? 'No relation is named one at a time.'
      : `${String(declaration.named.length)} ${declaration.named.length === 1 ? 'relation is' : 'relations are'} named one at a time.`;

  const tagged =
    declaration.tagged.length === 0
      ? 'No tag selects a relation.'
      : declaration.tagged
          .map((selector) => {
            const values =
              selector.values == null || selector.values.length === 0
                ? 'any value'
                : selector.values.map((value) => `“${value}”`).join(' or ');
            return `A tag ${selector.key} = ${values} at ${selector.at.join(', ')} level selects a relation.`;
          })
          .join(' ');

  return [named, tagged];
}

/** What every selected relation then owes, from the declaration rather than from this app. */
export function obligationPhrases(declaration: NonNullable<FoundationReadiness['declaration']>): readonly string[] {
  const phrases: string[] = [];
  if (declaration.requiredMetadata.length > 0) {
    // Listed rather than joined into a noun phrase. "A description and a owner" is what the obvious
    // version produces, and an article agreeing with a field name is a thing this file would then owe
    // for every field somebody adds.
    phrases.push(`Every serving relation must carry: ${declaration.requiredMetadata.join(', ')}.`);
  }
  if (declaration.requiredTagKeys.length > 0) {
    phrases.push(
      `Every serving relation must carry the tag ${declaration.requiredTagKeys.length === 1 ? 'key' : 'keys'} ` +
        `${declaration.requiredTagKeys.join(', ')}, whatever value it sets.`
    );
  }
  for (const rule of declaration.policy) {
    phrases.push(`A relation classified ${rule.classification} must carry ${rule.requires.join(' and ')}.`);
  }
  if (phrases.length === 0) {
    phrases.push('The declaration requires nothing of a serving relation beyond being one.');
  }
  return phrases;
}
