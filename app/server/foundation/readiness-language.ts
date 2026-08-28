// The sentence beside each dimension, and what each one may not say.
//
// Separate from `readiness.ts` for the reason [`schedule-language.ts`](../../client/src/pages/schedule-language.ts)
// is separate from the panel it serves: a sentence a reader acts on has to be reviewable next to the
// rule it obeys, and a sentence composed inline gets reviewed as code. Composed on the server rather
// than in the client so there is one copy of it — a phrase the app no longer means cannot go on being
// rendered by a page that has its own.
//
// The rule every line here obeys, from `AGENTS.md`: **a sentence may be no more specific than the
// field under it.** Each of these describes what the dimension counted, and none of them says what the
// platform will do, whether the estate is safe, or whether a share is good. Three particular traps,
// each of which a first draft of this file fell into:
//
//   * **`quality-monitoring` counts whether a status exists, not whether it was a passing one.** The
//     four values the platform writes are the platform's, and this app has measured what none of them
//     means. "Monitored" is what the field carries; "healthy" would be this module deciding that on
//     the platform's behalf.
//   * **`storage-format` says format and never speed.** The plan called this dimension performance.
//     No source measured attributes a query's cost or its latency to a table, so a sentence with
//     "faster" in it would be a prediction about the platform dressed as a reading of a column.
//   * **`semantic-assets` counts metric views and the assets they read, in the window.** Not "has a
//     semantic layer", which is a claim about a thing the platform does not have a field for.

import type { DimensionId } from './readiness.js';

export interface DimensionLanguage {
  /** The customer question this reading belongs to. It is a grouping, never a roll-up. */
  readonly area: 'governance' | 'metadata' | 'semantics' | 'freshness' | 'performance';
  /** Two or three words, for a heading. Never a verdict: no "good", no "healthy". */
  readonly label: string;
  /** What the dimension counted, in one sentence a reader can check against the denominator. */
  readonly asks: string;
  /** The exact statement ids whose fields feed the reading. */
  readonly sources: readonly string[];
}

const LANGUAGE: Readonly<Record<DimensionId, DimensionLanguage>> = {
  'unity-catalog-boundary': {
    area: 'governance',
    label: 'Inside Unity Catalog',
    asks:
      'How many serving assets are relations Unity Catalog governs itself, rather than ones reached ' +
      'through a connection to another system.',
    sources: ['sql:serving.population', 'sql:serving.facts'],
  },
  'table-metadata': {
    area: 'metadata',
    label: 'Table metadata',
    asks:
      'How many carry the description, the owner and the tag keys this declaration says a serving ' +
      'asset must have. What is required is the declaration’s own list, not this app’s.',
    sources: ['sql:serving.population', 'sql:serving.tags'],
  },
  'column-metadata': {
    area: 'metadata',
    label: 'Column comments',
    asks: 'How many have a comment on every column the read found. An asset with no columns read is not counted.',
    sources: ['sql:serving.population', 'sql:serving.facts'],
  },
  'semantic-assets': {
    area: 'semantics',
    label: 'Semantic assets',
    asks:
      'How many are a metric view, or are read by one somewhere in the lineage window. Says nothing ' +
      'about whether the metrics defined over them are the right ones.',
    sources: ['sql:serving.population', 'sql:serving.facts'],
  },
  lineage: {
    area: 'freshness',
    label: 'Lineage',
    asks:
      'How many appear on either side of a lineage event inside the window. An asset with none was ' +
      'not read or written in the window, which is not the same as an asset nothing depends on.',
    sources: ['sql:serving.population', 'sql:serving.facts'],
  },
  'quality-monitoring': {
    area: 'freshness',
    label: 'Quality monitoring',
    asks:
      'How many have a status recorded against them by the platform’s own quality monitoring. Whether ' +
      'a status exists — not whether it was a passing one, which is the platform’s word and not this app’s.',
    sources: ['sql:serving.population', 'sql:serving.facts', 'sql:serving.quality'],
  },
  'policy-controls': {
    area: 'governance',
    label: 'Policy controls',
    asks:
      'Of the assets a classification rule in this declaration applies to, how many carry the ' +
      'protections it requires. Assets no rule covers are out of the count rather than passing it.',
    sources: ['sql:serving.population', 'sql:serving.facts', 'sql:serving.classes'],
  },
  'storage-format': {
    area: 'performance',
    label: 'Storage format',
    asks:
      'Of the assets that store data of their own, how many store it in Delta or Iceberg. A reading of ' +
      'the format column, and not of how anything performs.',
    sources: ['sql:serving.population', 'sql:serving.facts'],
  },
};

export function dimensionLanguage(id: DimensionId): DimensionLanguage {
  return LANGUAGE[id];
}
