// Reading the guidance corpus as prose, so `check-guidance.mjs` can hold it to more than its shape.
//
// Separated from the check for the same reason `guidance-review.mjs` was: the interesting part is
// the judgement — which words count, what counts as saying the same thing, what counts as a
// regulatory claim — and a threshold buried in a 400-line script is a threshold nobody revisits.
// Here it can be tested against the corpus it was measured on.

/**
 * How alike two entries may read before it is a fault, as a share of significant words in common.
 *
 * Measured, not chosen. Across the 1,953 pairs of authored entries in the tree on 2026-08-10, the
 * closest pair of `means` scored 0.185 by the metric below, the closest `matters` 0.317 and the
 * closest `partial_when` 0.261 — a corpus written one requirement at a time tops out at about a
 * third. Half is well clear of that and well under what a paragraph reused across two requirements
 * scores, and the gap between the two is the headroom an author needs: writing about two related
 * requirements should not trip this, and pasting one entry over another should.
 *
 * Three fields, not the four this compares. `start_from` had two entries the day the bar was set,
 * deliberately chosen as opposite ends of the schema, so its one pair scores 0.000 and measures
 * nothing. The bar over it is inherited from the other three rather than measured, and `L1c` is where
 * it first gets tested — which is why the test beside this file re-takes the closest pair over the
 * whole corpus and fails at 0.40, rather than trusting the three numbers above to stay true.
 */
export const SIMILAR = 0.5;

/**
 * The regulations a claim would be made about.
 *
 * Named ones only. "Regulatory requirement" in the abstract is a description of why somebody is
 * asking; "GDPR requires this" is a statement about the law, and this project is not in a position
 * to make one without saying where it read it.
 */
export const REGULATIONS =
  /\b(GDPR|HIPAA|PCI[-\s]?DSS|SOC ?2|ISO[-\s]?27001|FedRAMP|CCPA|CPRA|DORA|NIS ?2|SOX|Sarbanes[-\s]?Oxley|Basel|MiFID|HITRUST|FISMA|CJIS|IRAP|Schrems)\b/i;

/**
 * The same regulation under another name, where a source is likely to use the other one.
 *
 * Two groups only, and both are the same regulation rather than a related one: a page about the
 * Payment Card Industry Data Security Standard is as often filed under `pci` as `pci-dss`, and
 * Sarbanes-Oxley is more often filed under `sox` than spelled out. Everything else in the list above
 * is cited under the name the prose would use it by. Kept short deliberately — an alias table is a
 * list of ways to satisfy the rule without citing the obligation, so each entry has to earn itself.
 */
const ALIASES = {
  pcidss: ['pci'],
  sox: ['sox', 'sarbanesoxley'],
  sarbanesoxley: ['sox', 'sarbanesoxley'],
};

/** Letters and digits only, so `PCI-DSS`, `PCI DSS` and a `pci_dss` path segment are one token. */
const compact = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** One regulation a passage names, with the tokens a citation of it would carry. */
function named(text) {
  const found = new Map();
  for (const match of text.matchAll(new RegExp(REGULATIONS.source, 'gi'))) {
    const token = compact(match[0]);
    if (!found.has(token)) found.set(token, { named: match[0], token, accepted: ALIASES[token] ?? [token] });
  }
  return [...found.values()];
}

/**
 * The regulations an entry names without citing one, which is the claim this project may not make.
 *
 * What it checks is that a source naming the regulation is among the references — not that the source
 * supports the sentence, which nothing here can check and `last_reviewed` is the only guard for. That
 * is a low bar on purpose, and it is a different bar from "cites something": an entry may satisfy the
 * citation rule with a page about cluster policies and still assert what the law requires, and the
 * whole reason this rule exists is that the assertion is the part a customer would act on.
 */
export function uncitedRegulations(entry) {
  const cited = compact((entry?.references ?? []).join(' '));
  return named(prose(entry).join(' ')).filter((one) => !one.accepted.some((token) => cited.includes(token)));
}

/** Every sentence of an entry a reader sees, which is where a claim about the law would be made. */
export function prose(entry) {
  const advice = entry?.advice ?? {};
  return [
    entry?.means,
    entry?.matters,
    entry?.partial_when,
    entry?.not_applicable_when,
    ...(entry?.good ?? []),
    ...(entry?.pitfalls ?? []),
    ...Object.values(entry?.examples ?? {}),
    ...(entry?.verify ?? []).flatMap((check) => [check?.where, check?.expect, check?.caveat]),
    advice.start_from,
    advice.retain,
    advice.revisit,
    ...(advice.depends_on ?? []),
    ...(advice.path ?? []),
    ...(advice.costs ?? []),
  ].filter((part) => typeof part === 'string');
}

/**
 * The words worth comparing, which are the long ones.
 *
 * Four letters and up drops the articles, prepositions and auxiliaries every English sentence
 * shares. Without that, two unrelated paragraphs already overlap enough that any threshold over them
 * would be arbitrary — which is the trap in measuring a bar and then measuring it differently. A set
 * rather than a list, so repeating a word does not make two entries look alike.
 */
export function significant(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3)
  );
}

export function jaccard(one, other) {
  let shared = 0;
  for (const word of one) if (other.has(word)) shared++;
  const union = one.size + other.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * The fields compared for near-duplication, and only these.
 *
 * The four that carry a recommendation. `good` and `pitfalls` are deliberately out: they are lists of
 * short signals, several requirements legitimately share one ("owners are groups rather than people"),
 * and a set of six words hits a high overlap by accident — which would make this gate the thing that
 * teaches authors to reword a true sentence until a script stops complaining.
 */
export const COMPARED = ['means', 'matters', 'partial_when', 'start_from'];

function textOf(entry, field) {
  const value = field === 'start_from' ? entry?.advice?.start_from : entry?.[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Pairs of entries that say nearly the same thing, worst first.
 *
 * `entries` is `[id, entry]` pairs, as `check-guidance.mjs` holds them.
 */
export function nearDuplicates(entries, threshold = SIMILAR) {
  const indexed = [];
  for (const [id, entry] of entries) {
    for (const field of COMPARED) {
      const text = textOf(entry, field);
      if (text != null) indexed.push({ id, field, words: significant(text) });
    }
  }

  const found = [];
  for (let i = 0; i < indexed.length; i++) {
    for (let j = i + 1; j < indexed.length; j++) {
      const one = indexed[i];
      const other = indexed[j];
      if (one.id === other.id || one.field !== other.field) continue;
      const overlap = jaccard(one.words, other.words);
      if (overlap >= threshold) found.push({ one: one.id, other: other.id, field: one.field, overlap });
    }
  }

  return found.sort((a, b) => b.overlap - a.overlap);
}

/** The closest pair in a corpus, which is what the threshold above was set against. */
export function closestPair(entries) {
  return nearDuplicates(entries, 0).at(0);
}
