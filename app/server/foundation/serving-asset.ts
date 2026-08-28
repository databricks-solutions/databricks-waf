// Which tables a customer serves to people, and what that obliges of them.
//
// This is the population every dimension of the Genie and Unity Catalog readiness outcome is a share
// of, and it is the one part of that outcome nobody can measure their way to: the platform holds no
// field that says a table is served. So it is declared, and this module is the declaration and the
// rules it has to survive. `45c` builds the dimensions over the population this produces.
//
// **A name classifies nothing.** A table is serving because somebody named it or because it carries a
// tag the definition names — never because of what it or its schema or its catalog is called. The audit
// asks for that in those words and for adversarial tests that prove it (`AUD-DEC-121`), and there is a
// worked reason underneath the preference: a schema called `gold` is a convention held by whoever named
// it, on the day they named it, and a score built on it moves when somebody renames a schema. What makes
// it not merely the better option is that [`45a`](../../../docs/plan/42-customer-operating-product.md#pr-45a)
// measured the alternative away — **a Genie space does not name the tables it serves**, over a complete
// walk of 4,181 of them, so there is nothing to read a served population off. Declaration is the only
// thing left, and the tests beside this file are what hold the line.
//
// **The two halves are deliberately different, and conflating them is the failure mode.** What is
// required of *every* serving asset is metadata: a description, an owner, the tag keys the definition
// names. What is required *where a classification says so* is protection: a column mask, a row filter,
// an ABAC policy. Requiring the second of everything turns a readiness score into a demand that every
// table carry a mask, which no estate meets and none should — a public reference table with a mask on it
// is a misconfiguration, not a pass.
//
// **Nothing is required of the estate by default, because the estate has no default.** `45a` counted
// **2,046 distinct table tag keys over 9,556 tagged tables** on the measurement estate. A shipped
// convention — `certification = gold`, say — would score every one of those customers against a key
// their estate has never heard of, so the definition names its own keys and there is no default set. A
// definition that selects nothing is refused rather than stored: "no serving assets are declared" is the
// absence of this record, and `45c` reports that absence as unmeasured rather than as a population of
// zero that every share divides by.
//
// What this module deliberately does not do: read anything, store anything, or produce a score. It takes
// evidence its caller read and returns readings. The shape is `apply/applicability.ts`'s and
// `accept/risk.ts`'s, and for their reason — the rules are the hard part and they are testable without a
// database or a warehouse in front of them.
//
// See ADR 0085.

import { digestOf, type Digest } from '../records/digest.js';

/**
 * A relation, as its three parts rather than as a qualified string.
 *
 * Structured because the app must never split a qualified name back into parts. A split is a
 * reinterpretation of a name, which is the one operation this whole module exists to refuse, and it is
 * where the interesting bug lives even when nobody intended inference: `main.gold.customers` split on
 * the dots is three identifiers only if no identifier contains a dot, and a definition that quietly
 * misreads one name is a population with a wrong member in it and nothing saying so.
 *
 * Callers assembling one from `information_schema` already have the three columns. Callers taking one
 * from a person should ask for three fields.
 */
export interface AssetName {
  readonly catalog: string;
  readonly schema: string;
  readonly table: string;
}

/** Where a tag sits. A column tag is not here: a tag on one column does not make a table served. */
export type TagLevel = 'catalog' | 'schema' | 'table';

/** The thing a tag is on, at each of the three levels a tag can make an asset serving from. */
export type Securable =
  | { readonly level: 'catalog'; readonly catalog: string }
  | { readonly level: 'schema'; readonly catalog: string; readonly schema: string }
  | { readonly level: 'table'; readonly catalog: string; readonly schema: string; readonly table: string };

/**
 * A tag that makes an asset serving, by the key the platform stores it under.
 *
 * `at` is a list because `45a` found tags at all four levels and a definition reading only `table_tags`
 * would report an estate tagged at the schema as untagged. It is required rather than defaulted to all
 * three: "every table in a catalog tagged this way is served" is a much larger claim than "this table
 * is", and a default would make the larger one the one nobody typed.
 *
 * `values` absent means any value of the key counts, which is the right reading of a key like
 * `data_product`. A present list is the reading of a key like `certification`, where `gold` and
 * `deprecated` are both values and only one of them is a serving asset. An empty list would be a
 * selector that can never match, so it is refused rather than stored.
 */
export interface TagSelector {
  readonly key: string;
  readonly values?: readonly string[];
  readonly at: readonly TagLevel[];
}

/** What every serving asset must carry, whatever it holds. Column comments belong to `45c`. */
export type MetadataField = 'description' | 'owner';

/** What a classification can require. Each is a thing the platform records against a table. */
export type Protection = 'column-mask' | 'row-filter' | 'abac-policy';

/**
 * What a classification obliges, and nothing about what it obliges of anything else.
 *
 * Keyed on the class the platform's own classification writes — `class_tag` in
 * `system.data_classification.results` — so the matrix is checkable against a relation rather than
 * against a policy document nobody can join to.
 */
export interface PolicyRule {
  readonly classification: string;
  readonly requires: readonly Protection[];
}

/** What a customer has declared they serve, and what they have declared it must carry. */
export interface ServingDefinition {
  /** 1 for the first, one higher for each revision. The caller owns the sequence. */
  readonly version: number;
  /** Assets named one at a time, in canonical order. */
  readonly named: readonly AssetName[];
  readonly tagged: readonly TagSelector[];
  /** Every serving asset must carry each of these tag keys, whatever value it sets. */
  readonly requiredTagKeys: readonly string[];
  readonly requiredMetadata: readonly MetadataField[];
  /** Protection required only where a class in this matrix is on the asset. Empty requires none. */
  readonly policy: readonly PolicyRule[];
  /** Over the whole definition, so two readings can say whether they were taken under the same one. */
  readonly fingerprint: Digest;
}

export class ServingDefinitionError extends Error {}

/**
 * Everything about matching that folds case, in one place, with the assumption it rests on named.
 *
 * **Assumed: an estate does not hold two things whose names differ only in case.** Unity Catalog is
 * documented as case-insensitive for identifiers, and this has not been measured here. What the
 * assumption costs if it is wrong is a definition naming one of two distinct relations and matching
 * both; what folding buys is that a customer who types `Main.Sales.Orders` gets the table
 * `information_schema` reports as `main.sales.orders`, rather than an empty population and no reason.
 *
 * Tag keys and values fold too, and values are where it matters most: a value is typed by a person, so
 * `Gold` and `gold` are one convention entered twice. The cost is the same and the frequency is higher.
 */
function fold(value: string): string {
  return value.trim().toLowerCase();
}

/** The matching key for a table, built here and never parsed back. */
export function qualify(name: AssetName): string {
  return [fold(name.catalog), fold(name.schema), fold(name.table)].join('.');
}

function securableKey(on: Securable): string {
  if (on.level === 'catalog') return fold(on.catalog);
  if (on.level === 'schema') return [fold(on.catalog), fold(on.schema)].join('.');
  return [fold(on.catalog), fold(on.schema), fold(on.table)].join('.');
}

/** The securable key of `name` at `level`, which is what a tag at that level would be on. */
function keyAt(name: AssetName, level: TagLevel): string {
  if (level === 'catalog') return fold(name.catalog);
  if (level === 'schema') return [fold(name.catalog), fold(name.schema)].join('.');
  return qualify(name);
}

export interface ServingDraft {
  readonly named?: readonly AssetName[];
  readonly tagged?: readonly TagSelector[];
  readonly requiredTagKeys?: readonly string[];
  readonly requiredMetadata?: readonly MetadataField[];
  readonly policy?: readonly PolicyRule[];
}

/**
 * A draft, checked and put in canonical form, or an error saying which part of it was not a definition.
 *
 * Every refusal here is one of two kinds. Some are the ordinary ones a stored record needs — a blank
 * identifier, the same thing declared twice, a list that can never match. The rest are this module's
 * subject: a definition that would classify an asset by its name. Those are refused rather than
 * sanitised, because a pattern silently read as a literal name is a definition that selects nothing and
 * reads as a definition that selects a hundred tables.
 */
export function defineServing(draft: ServingDraft, version: number): ServingDefinition {
  if (!Number.isInteger(version) || version < 1) {
    throw new ServingDefinitionError(`A version is a whole number from 1, and ${String(version)} is not.`);
  }

  const named = namedAssets(draft.named ?? []);
  const tagged = selectors(draft.tagged ?? []);
  if (named.length === 0 && tagged.length === 0) {
    throw new ServingDefinitionError(
      'A serving definition that names no assets and no tag would declare nothing to be served. ' +
        'Name the assets, or the tag that marks them.',
    );
  }

  const requiredTagKeys = keys(draft.requiredTagKeys ?? []);
  const requiredMetadata = [...new Set(draft.requiredMetadata ?? [])].sort();
  const policy = matrix(draft.policy ?? []);

  return {
    version,
    named,
    tagged,
    requiredTagKeys,
    requiredMetadata,
    policy,
    fingerprint: digestOf({ named, tagged, requiredTagKeys, requiredMetadata, policy }),
  };
}

/**
 * Anything that would make an identifier match more than the one thing it names.
 *
 * The wildcards are the obvious half. The quoting characters are the half that has to be said out loud:
 * a customer pasting `` `main`.`gold`.`orders` `` out of a notebook has given three identifiers that
 * are not the three the catalogue reports, and accepting them would produce an asset that silently
 * never matches. Refusing names the paste; stripping the backticks would be this module deciding what
 * somebody's identifier is.
 */
const NOT_AN_IDENTIFIER = /[*%?`"[\]]/u;

function identifier(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new ServingDefinitionError(`A blank ${what} names nothing. Name the one that was meant, or remove it.`);
  }
  if (NOT_AN_IDENTIFIER.test(trimmed)) {
    throw new ServingDefinitionError(
      `"${trimmed}" is not a ${what}: it holds a wildcard or a quote. A serving asset is named or tagged, ` +
        'never matched by a pattern — a pattern is the name inference this definition exists to refuse.',
    );
  }
  return trimmed;
}

function namedAssets(assets: readonly AssetName[]): readonly AssetName[] {
  const seen = new Map<string, AssetName>();
  for (const asset of assets) {
    const name: AssetName = {
      catalog: identifier(asset.catalog, 'catalog'),
      schema: identifier(asset.schema, 'schema'),
      table: identifier(asset.table, 'table'),
    };
    // Last one wins over a duplicate rather than being refused, because two entries that fold to one
    // name are the same asset written twice and there is no second reading to choose between. This is
    // the opposite call from a duplicate tag selector, which can hold two different value lists.
    seen.set(qualify(name), name);
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, name]) => name);
}

const LEVELS: readonly TagLevel[] = ['catalog', 'schema', 'table'];

function selectors(tagged: readonly TagSelector[]): readonly TagSelector[] {
  const kept = new Map<string, TagSelector>();
  for (const selector of tagged) {
    const key = fold(identifier(selector.key, 'tag key'));
    if (selector.at.length === 0) {
      throw new ServingDefinitionError(
        `The ${key} selector says nothing about where the tag has to be. Name at least one of ` +
          'catalog, schema or table — a tag on a catalog says every table under it is served, which is ' +
          'a larger claim than a tag on one table and should be made deliberately.',
      );
    }
    const at = LEVELS.filter((level) => selector.at.includes(level));
    if (at.length === 0) {
      // Every level it named is one this module does not know. The type refuses that at compile time and
      // a definition read back from a store or a request body has not been near the compiler, so the
      // check is here too: a selector at no known level is one that can never match, which is the state
      // the branch above already refuses under a different spelling.
      throw new ServingDefinitionError(
        `The ${key} selector names no level this build knows: ${selector.at.join(', ')}. ` +
          'A tag sits on a catalog, a schema or a table.',
      );
    }
    if (selector.values != null && selector.values.length === 0) {
      throw new ServingDefinitionError(
        `The ${key} selector accepts no values, so it can never match anything. Leave the values out to ` +
          'accept any value of the key.',
      );
    }
    const values =
      selector.values == null
        ? undefined
        : [...new Set(selector.values.map((value) => fold(identifier(value, 'tag value'))))].sort();
    const folded: TagSelector = { key, ...(values != null ? { values } : {}), at };
    if (kept.has(key)) {
      // Refused rather than merged. Two selectors on one key differ in their values or their levels, and
      // merging them would decide which of two claims the customer made — the same call `definition.ts`
      // makes about two targets for one pillar.
      throw new ServingDefinitionError(
        `The tag key ${key} is selected on twice. One key has one selector, so say which of them is meant.`,
      );
    }
    kept.set(key, folded);
  }
  return [...kept.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function keys(required: readonly string[]): readonly string[] {
  return [...new Set(required.map((key) => fold(identifier(key, 'tag key'))))].sort();
}

function matrix(policy: readonly PolicyRule[]): readonly PolicyRule[] {
  const kept = new Map<string, PolicyRule>();
  for (const rule of policy) {
    const classification = fold(identifier(rule.classification, 'classification'));
    if (rule.requires.length === 0) {
      throw new ServingDefinitionError(
        `The rule for ${classification} requires no protection, which is what having no rule for it ` +
          'already means. Remove it, or say what it requires.',
      );
    }
    if (kept.has(classification)) {
      throw new ServingDefinitionError(
        `There are two rules for ${classification}. A classification has one rule, so say which is meant.`,
      );
    }
    kept.set(classification, { classification, requires: [...new Set(rule.requires)].sort() });
  }
  return [...kept.values()].sort((a, b) => a.classification.localeCompare(b.classification));
}

/**
 * A tag as the three `information_schema` tag relations return one.
 *
 * One shape for all three, because a tag is the same fact wherever it sits and the level is already in
 * the securable. The caller maps `catalog_tags`, `schema_tags` and `table_tags` onto it.
 */
export interface TagFact {
  readonly on: Securable;
  readonly key: string;
  readonly value: string;
}

/** A table the catalogue holds, with the metadata a definition can require of it. */
export interface CataloguedAsset {
  readonly name: AssetName;
  /** Absent where the read did not carry it, which reads as unmeasured rather than as missing. */
  readonly description?: string | null;
  readonly owner?: string | null;
}

/** A class the platform's classification put on a table. */
export interface ClassificationFact {
  readonly on: AssetName;
  readonly classification: string;
}

/** A protection the platform records on a table. */
export interface ProtectionFact {
  readonly on: AssetName;
  readonly protection: Protection;
}

/**
 * What a caller read, with `null` meaning it did not read it.
 *
 * `null` and `[]` are different answers and the distinction is load-bearing throughout: an estate with
 * no masks and an estate whose masks nobody could read produce the same empty list and opposite
 * readings. This is `45a`'s `empty` against `unread` one layer up, and it is the reason every reading
 * below carries `unmeasured` as a standing rather than folding it into a failure.
 */
export interface ServingEvidence {
  readonly catalogued: readonly CataloguedAsset[] | null;
  readonly tags: readonly TagFact[] | null;
  readonly classifications: readonly ClassificationFact[] | null;
  readonly protections: readonly ProtectionFact[] | null;
  /**
   * Protections the read does not carry at all, as opposed to ones it carries and found none of.
   *
   * The finer half of the same distinction one line up. `protections: []` says the caller looked and
   * this estate protects nothing; this says the caller did not look for *these kinds*, so an asset
   * requiring one of them is unmeasured rather than short. `45c`'s read populates it with
   * `abac-policy` and nothing else, because `abac_policy_definitions` returned 720 rows in sixteen and
   * a half minutes on the measurement estate and no read this app ships goes near it — and without
   * this field, a customer whose matrix requires an ABAC policy would be told every classified table
   * they own is unprotected, on the strength of a source nobody queried.
   */
  readonly unreadProtections?: readonly Protection[];
}

/** Why an asset is in the population. Every member carries one; there is no third way in. */
export type Because =
  | { readonly kind: 'named' }
  | {
      readonly kind: 'tagged';
      readonly key: string;
      readonly value: string;
      readonly at: TagLevel;
    };

export interface ServingAsset {
  readonly name: AssetName;
  readonly qualified: string;
  readonly because: Because;
}

export interface ServingPopulation {
  /** In canonical name order, each with why it is here. */
  readonly assets: readonly ServingAsset[];
  /**
   * Named by the definition and absent from the catalogue that was read.
   *
   * Reported rather than dropped, for `definition.ts`'s reason about a named workspace that is not in
   * the directory: a definition that names five tables and produces four is either a table that was
   * dropped or a grant that was lost, and a population that quietly shrinks says neither.
   */
  readonly missing: readonly AssetName[];
  /** True where the catalogue was not read, which makes every count here a fact about the read. */
  readonly catalogueUnread: boolean;
  /** True where tags were not read, so a tag selector could not have matched. */
  readonly tagsUnread: boolean;
}

/**
 * The population a definition selects out of what was read.
 *
 * Named assets are matched against the catalogue rather than trusted, because the definition is written
 * once and read every run, and a table that has since been dropped is a member this app cannot say
 * anything about. A tagged asset is by construction in the catalogue: it was found by walking it.
 *
 * A table matched by both is `named`. The reasons are not ranked by strength — they are ranked by which
 * one a reader can act on, and "you named this" is a sentence with somebody in it.
 */
export function servingPopulation(
  definition: ServingDefinition,
  evidence: ServingEvidence,
): ServingPopulation {
  const catalogued = evidence.catalogued ?? [];
  const byName = new Map(catalogued.map((asset) => [qualify(asset.name), asset.name]));

  const assets = new Map<string, ServingAsset>();
  const missing: AssetName[] = [];

  for (const name of definition.named) {
    const key = qualify(name);
    const held = byName.get(key);
    if (held == null) {
      // Not reported missing when the catalogue was not read at all: nothing was looked for, so nothing
      // is absent, and a list of every named asset under the heading "missing" would be a read failure
      // reported as an estate that dropped its tables.
      if (evidence.catalogued != null) missing.push(name);
      continue;
    }
    assets.set(key, { name: held, qualified: key, because: { kind: 'named' } });
  }

  const tagged = new Map<string, Because & { readonly kind: 'tagged' }>();
  for (const tag of evidence.tags ?? []) {
    const selector = definition.tagged.find((one) => one.key === fold(tag.key));
    if (selector == null) continue;
    const value = fold(tag.value);
    if (selector.values != null && !selector.values.includes(value)) continue;
    const level = tag.on.level;
    if (!selector.at.includes(level)) continue;

    const on = securableKey(tag.on);
    for (const asset of catalogued) {
      if (keyAt(asset.name, level) !== on) continue;
      const key = qualify(asset.name);
      if (assets.has(key)) continue;
      const because = { kind: 'tagged', key: selector.key, value, at: level } as const;
      const held = tagged.get(key);
      if (held == null || nearer(because, held) < 0) tagged.set(key, because);
    }
  }
  for (const [key, because] of tagged) {
    const asset = byName.get(key);
    if (asset != null) assets.set(key, { name: asset, qualified: key, because });
  }

  return {
    assets: [...assets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, asset]) => asset),
    missing: missing.sort((a, b) => qualify(a).localeCompare(qualify(b))),
    catalogueUnread: evidence.catalogued == null,
    tagsUnread: evidence.tags == null,
  };
}

const NEARNESS: Readonly<Record<TagLevel, number>> = { table: 0, schema: 1, catalog: 2 };

/**
 * Which of two tags gets to be the reason, where more than one put an asset in the population.
 *
 * The nearest tag wins — a tag on the table over one on its schema over one on its catalog — and ties
 * are broken on the key and then the value, both of which are already folded. What matters more than
 * which rule this is, is that there is one: without it the sentence a reader sees is decided by the
 * order the caller's rows came back in, which is a property of a SQL statement nobody wrote down.
 */
function nearer(
  one: { readonly at: TagLevel; readonly key: string; readonly value: string },
  other: { readonly at: TagLevel; readonly key: string; readonly value: string },
): number {
  if (NEARNESS[one.at] !== NEARNESS[other.at]) return NEARNESS[one.at] - NEARNESS[other.at];
  if (one.key !== other.key) return one.key.localeCompare(other.key);
  return one.value.localeCompare(other.value);
}

/** Whether a requirement was met, was not, or could not be read. Never "met because nothing was read". */
export type Standing = 'met' | 'short' | 'unmeasured';

export interface MetadataReading {
  readonly qualified: string;
  readonly standing: Standing;
  /** The required tag keys this asset does not carry. Empty where tags were not read. */
  readonly missingTagKeys: readonly string[];
  /** The required metadata fields it does not carry, or that the read did not carry. */
  readonly missingMetadata: readonly MetadataField[];
  /** Which required things could not be read at all, which is why the standing may be `unmeasured`. */
  readonly unread: readonly ('tags' | MetadataField)[];
}

/**
 * What each serving asset owes under the metadata half, and whether it has it.
 *
 * This is the half that applies to everything in the population, and the only reason an asset is
 * exempt from any of it is that the definition did not ask. An asset the evidence cannot speak to is
 * `unmeasured` and stays in the population — a readiness dimension counts it in its denominator and
 * says so, which is the audit's "missing or unreadable evidence is unmeasured rather than failed".
 */
export function metadataReadings(
  definition: ServingDefinition,
  population: ServingPopulation,
  evidence: ServingEvidence,
): readonly MetadataReading[] {
  const held = new Map((evidence.catalogued ?? []).map((asset) => [qualify(asset.name), asset]));
  const tagged = new Map<string, Set<string>>();
  for (const tag of evidence.tags ?? []) {
    if (tag.on.level !== 'table') continue;
    const key = securableKey(tag.on);
    const keys = tagged.get(key) ?? new Set<string>();
    keys.add(fold(tag.key));
    tagged.set(key, keys);
  }

  return population.assets.map((asset) => {
    const unread: ('tags' | MetadataField)[] = [];
    const carried = tagged.get(asset.qualified) ?? new Set<string>();
    const missingTagKeys = evidence.tags == null ? [] : definition.requiredTagKeys.filter((key) => !carried.has(key));
    if (evidence.tags == null && definition.requiredTagKeys.length > 0) unread.push('tags');

    const row = held.get(asset.qualified);
    const missingMetadata: MetadataField[] = [];
    for (const field of definition.requiredMetadata) {
      const value = row == null ? undefined : field === 'description' ? row.description : row.owner;
      // Undefined is the read not carrying the column; null and blank are the platform saying the field
      // is not set. The two look identical to a caller that only checks for falsehood, which is how a
      // column nobody selected becomes an estate with no owners.
      if (value === undefined) {
        unread.push(field);
        continue;
      }
      if (value == null || value.trim() === '') missingMetadata.push(field);
    }

    const standing: Standing =
      unread.length > 0 ? 'unmeasured' : missingTagKeys.length > 0 || missingMetadata.length > 0 ? 'short' : 'met';

    return { qualified: asset.qualified, standing, missingTagKeys, missingMetadata, unread };
  });
}

export interface PolicyReading {
  readonly qualified: string;
  /** `not-required` is the whole point of the second half: an unclassified table owes no protection. */
  readonly standing: Standing | 'not-required';
  /** The classes on this asset that the matrix has a rule for, in canonical order. */
  readonly classifications: readonly string[];
  readonly required: readonly Protection[];
  readonly held: readonly Protection[];
  readonly missing: readonly Protection[];
}

/**
 * What each serving asset owes under the policy half, which is nothing unless a class says otherwise.
 *
 * Three states rather than two, and the third is why this is a separate function from the metadata
 * half. An asset with no classification requiring protection is `not-required` — not passing, not
 * failing, not applicable. Rolling that into `met` would let an estate that classifies nothing report
 * full marks on the policy dimension, which is the exact inversion of what the dimension is for.
 *
 * An empty matrix means the customer has declared no protection rules, so every asset is
 * `not-required` and `45c` reports the dimension as undeclared rather than as passed.
 */
export function policyReadings(
  definition: ServingDefinition,
  population: ServingPopulation,
  evidence: ServingEvidence,
): readonly PolicyReading[] {
  const classes = new Map<string, Set<string>>();
  for (const fact of evidence.classifications ?? []) {
    const key = qualify(fact.on);
    const held = classes.get(key) ?? new Set<string>();
    held.add(fold(fact.classification));
    classes.set(key, held);
  }
  const protections = new Map<string, Set<Protection>>();
  for (const fact of evidence.protections ?? []) {
    const key = qualify(fact.on);
    const held = protections.get(key) ?? new Set<Protection>();
    held.add(fact.protection);
    protections.set(key, held);
  }

  return population.assets.map((asset) => {
    const on = [...(classes.get(asset.qualified) ?? new Set<string>())];
    const rules = definition.policy.filter((rule) => on.includes(rule.classification));
    const classifications = rules.map((rule) => rule.classification).sort();
    const required = [...new Set(rules.flatMap((rule) => rule.requires))].sort();

    if (evidence.classifications == null) {
      // Unmeasured before not-required, deliberately. With no classification read, "nothing requires a
      // mask here" is a statement about the read rather than about the table, and it is the statement
      // most likely to be quoted as though it were about the table.
      return { qualified: asset.qualified, standing: 'unmeasured', classifications: [], required: [], held: [], missing: [] };
    }
    if (required.length === 0) {
      return { qualified: asset.qualified, standing: 'not-required', classifications, required, held: [], missing: [] };
    }
    if (evidence.protections == null) {
      return { qualified: asset.qualified, standing: 'unmeasured', classifications, required, held: [], missing: [] };
    }

    const held = [...(protections.get(asset.qualified) ?? new Set<Protection>())].sort();
    // A protection nobody read cannot be one this asset is missing. Checked after `held` so an asset
    // that requires a mask and an ABAC policy and holds the mask still reads as unmeasured rather than
    // as met: it owes two things, one of them was checked, and "met" would be a claim about both.
    const unread = required.filter((one) => (evidence.unreadProtections ?? []).includes(one));
    if (unread.length > 0) {
      return { qualified: asset.qualified, standing: 'unmeasured', classifications, required, held, missing: [] };
    }
    const missing = required.filter((one) => !held.includes(one));
    return {
      qualified: asset.qualified,
      standing: missing.length === 0 ? 'met' : 'short',
      classifications,
      required,
      held,
      missing,
    };
  });
}
