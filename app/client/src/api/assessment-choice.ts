// Which assessment a run answers to, and which one the rest of the product is reading.
//
// Shared by the run control and the provider so the button and every list agree. Recency is the
// default among several, for the reason the control gives: an unstamped default on an install that
// has defined three assessments is the defect the control exists to close.

import { describeScope } from '../pages/definitions-language';
import type { AssessmentDefinition, DefinitionMeasurement, DefinitionVersion } from './types';

export interface AssessmentChoice {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  /** The exact current question, for a run confirmation that must not infer it from the sentence. */
  readonly measurement: DefinitionMeasurement;
  /** When its current version was written, which is what orders the list and picks the default. */
  readonly definedAt: string;
}

/** Chosen nothing yet, chosen an assessment, or chosen to read without one. */
export type Chosen =
  { readonly kind: 'unset' } | { readonly kind: 'none' } | { readonly kind: 'one'; readonly id: string };

export function choicesFrom(definitions: readonly AssessmentDefinition[]): readonly AssessmentChoice[] {
  const named: AssessmentChoice[] = [];
  for (const definition of definitions) {
    if (definition.archivedAt != null) continue;
    const current: DefinitionVersion | undefined = definition.versions.at(-1);
    if (current == null) continue;
    named.push({
      id: definition.id,
      name: current.attribution.name,
      scope: describeScope(current),
      measurement: current.measurement,
      definedAt: current.createdAt,
    });
  }
  return named.sort((a, b) => b.definedAt.localeCompare(a.definedAt) || a.name.localeCompare(b.name));
}

export function selectedChoice(chosen: Chosen, choices: readonly AssessmentChoice[]): AssessmentChoice | undefined {
  if (chosen.kind === 'none') return undefined;
  if (chosen.kind === 'one') return choices.find((choice) => choice.id === chosen.id);
  return choices[0];
}

/**
 * The query value every product read should send.
 *
 * `undefined` while definitions are still loading, so lists do not fetch the unscoped view for a
 * frame and then replace it. `null` when the reader chose to work without an assessment, or when
 * none exist. A string is the selected definition.
 */
export function definitionIdOf(
  loading: boolean,
  loaded: boolean,
  chosen: Chosen,
  selected: AssessmentChoice | undefined
): string | null | undefined {
  if (loading && !loaded) return undefined;
  if (chosen.kind === 'none' || selected == null) return null;
  return selected.id;
}
