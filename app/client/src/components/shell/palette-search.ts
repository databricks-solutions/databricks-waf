// What ⌘K can take you to, and which of it a typed phrase means.
//
// Separate from the palette component and pure, because the interesting half of a palette is not the
// dialog — it is the answer to "does typing this find that", and that question has to be answerable
// without a browser. Everything below is a function of a catalogue, a run and a string.
//
// Three kinds of destination and no fourth. Pages, pillars and requirements are the app's three
// addressable things; a check has no address of its own (the checks page filters by pillar, not by
// check) and an evidence row is not a place. Acts are deliberately absent — see `PaletteEntry`.
//
// Matching is every typed word appearing somewhere, in any order, case-blind. Not fuzzy, and that is
// a decision rather than an omission: fuzzy subsequence scoring makes `CO-03-01` offer `CO-03-07`
// two rows below it under a near-identical score, and the cost of picking the wrong one is a reader
// quoting the wrong requirement in a meeting. Word-substring matching misses a typo, which is a
// failure the reader can see and correct, rather than answering confidently with a neighbour.

import type { Outcome } from '../../api/types';
import { DIAGNOSTICS, INVESTIGATE, NAV, OPERATE, RETENTION, START, TRAIL } from './nav';

/** Which of the three kinds a row is, which is also how the list is grouped. */
export type PaletteKind = 'page' | 'pillar' | 'requirement';

/**
 * One destination.
 *
 * A destination and not an act. A palette that could start a scan or park a finding would be a
 * second surface for a gated mutation — it would have to explain a refusal, name who may, and be
 * kept in step with the button that already does both. Going somewhere needs no permission, so this
 * needs no policy, and a reader who wants to run a scan is one keystroke from the header that runs
 * one. ADR 0058.
 */
export interface PaletteEntry {
  readonly kind: PaletteKind;
  /** Stable across renders and unique, because cmdk keys its selection on it. */
  readonly id: string;
  readonly label: string;
  /** Where it goes. A router path, so the palette never needs to know about the pages. */
  readonly to: string;
  /** The second line: what the page is for, which pillar a requirement belongs to. */
  readonly detail?: string;
  /**
   * The words a query is matched against, beyond the label.
   *
   * Held rather than derived at match time so a 184-entry catalogue is lowercased once per run
   * instead of once per keystroke.
   */
  readonly terms: string;
  /** What the current run said about this requirement, where it said anything. */
  readonly outcome?: Outcome;
}

/**
 * The pages, including the ones the rail keeps at its foot and the two that are children of another.
 *
 * The child pages are here and not on the rail because the rail is a spine and they are steps within
 * a page — but "walk" and "setup" are exactly the kind of thing somebody types into a palette rather
 * than goes looking for, and a navigator that cannot reach a route the app has is the reason this
 * list is data in one file rather than markup in three.
 */
const PAGES: readonly PaletteEntry[] = [
  ...[
    ...NAV.flatMap((group) => group.items).flatMap((item) => {
      if (item.to === '/review') return [item, INVESTIGATE];
      if (item.to === '/pillars' || item.to === '/findings' || item.to === '/topology') return [];
      return [item];
    }),
    START,
    OPERATE,
    DIAGNOSTICS,
    TRAIL,
    RETENTION,
  ].map((item) => ({
    kind: 'page' as const,
    id: `page:${item.to}`,
    label: item.label,
    to: item.to,
    detail: item.hint,
    terms: `${item.label} ${item.hint}`.toLowerCase(),
  })),
  {
    kind: 'page',
    id: 'page:/answers/walk',
    label: 'Answer the open requirements',
    to: '/answers/walk',
    detail: 'One requirement at a time, with what it is asking and what counts as evidence',
    terms: 'answer the open requirements walk attest attestation one at a time',
  },
  {
    kind: 'page',
    id: 'page:/definitions/setup',
    label: 'Set up an assessment',
    to: '/definitions/setup',
    detail: 'Choose what a scan covers, name who owns it, and record why',
    terms: 'set up an assessment definition scope owner new',
  },
];

/**
 * What this file reads of a catalogue, and no more.
 *
 * Stated structurally rather than as `CatalogueResponse`, because a search index needs six fields of a
 * payload that has some forty, and the alternative is a test fixture that spells out scores, coverage
 * and remediation so that a title can be matched against a word. The link to the contract is not lost
 * by writing it this way: the caller passes the real payload, so a renamed `pillars` or `criteria`
 * fails at that call rather than here. A `as unknown as CatalogueResponse` in the test would have kept
 * the name in this signature and thrown that check away — the fixture would still compile after the
 * rename, and the palette would find nothing.
 */
export interface SearchableCatalogue {
  readonly pillars: readonly {
    readonly id: string;
    readonly code: string;
    readonly title: string;
    readonly principles: readonly {
      readonly title: string;
      readonly controls: readonly {
        readonly id: string;
        readonly title: string;
        readonly criteria?: string;
      }[];
    }[];
  }[];
}

/** What this file reads of a run: which requirements it spoke about, and what it said. */
export interface SearchableRun {
  readonly findings: readonly { readonly controlId: string; readonly outcome: Outcome }[];
}

/**
 * Everything reachable, given what the app has loaded.
 *
 * Requirements come from the catalogue rather than from the run, so the palette reaches all 184 on a
 * workspace that has never been scanned — the catalogue is the census and the run is what happened to
 * it. The run only contributes the outcome badge.
 */
export function paletteEntries(catalogue?: SearchableCatalogue, scan?: SearchableRun): readonly PaletteEntry[] {
  const said = new Map((scan?.findings ?? []).map((finding) => [finding.controlId, finding.outcome]));
  const entries: PaletteEntry[] = [...PAGES];

  for (const pillar of catalogue?.pillars ?? []) {
    entries.push({
      kind: 'pillar',
      id: `pillar:${pillar.id}`,
      label: pillar.title,
      to: `/investigate?pillar=${encodeURIComponent(pillar.id)}`,
      detail: `${String(pillar.principles.reduce((count, one) => count + one.controls.length, 0))} requirements`,
      terms: `${pillar.title} ${pillar.code} ${pillar.id}`.toLowerCase(),
    });

    for (const principle of pillar.principles) {
      for (const control of principle.controls) {
        const outcome = said.get(control.id);
        entries.push({
          kind: 'requirement',
          id: `requirement:${control.id}`,
          label: control.title,
          // The census page with this row revealed, which is the one surface that holds the whole of
          // what is known about a requirement — its evidence, its expectation, its decisions.
          to: `/investigate?control=${encodeURIComponent(control.id)}`,
          detail: `${pillar.title} · ${control.id}`,
          // The criteria are in here and the remediation is not. Criteria are what the requirement
          // asks, which is how somebody who does not know its title describes it; remediation is
          // shell and SQL, and it made every requirement match "cluster" and "policy".
          terms: `${control.id} ${control.title} ${principle.title} ${control.criteria ?? ''}`.toLowerCase(),
          ...(outcome != null ? { outcome } : {}),
        });
      }
    }
  }

  return entries;
}

/** One group of results, in the order they are shown. */
export interface PaletteGroup {
  readonly kind: PaletteKind;
  readonly heading: string;
  readonly entries: readonly PaletteEntry[];
  /** How many were left out by the cap, so the group can say so rather than silently truncate. */
  readonly hidden: number;
}

const HEADINGS: Readonly<Record<PaletteKind, string>> = {
  page: 'Pages',
  pillar: 'Pillars',
  requirement: 'Requirements',
};

/**
 * How many rows a group will show.
 *
 * Pages and pillars are effectively uncapped, because both are bounded by the app: a query broad
 * enough to match all of either has told the reader something. Requirements are not bounded — a query
 * matching ninety of them has said nothing, and a list nobody will read to the bottom of buries the
 * pages above it under a scroll.
 *
 * The page cap counts the pages rather than naming a number, and that is not tidiness. It was 8 for
 * an afternoon, which is how the opening list came to be the eight pages whose names begin earliest
 * in the alphabet: Answers, Audit trail, Checks, Decisions, Definitions, Diagnostics, Exceptions —
 * and a note saying ten more. Overview, Pillars, Findings and Report, the four pages anybody opens,
 * were the ones behind the cap. Raising it to a bigger number each time a page is added is the same
 * bug with a longer fuse; a cap that is the length of the list cannot hide a page at all.
 */
const CAP: Readonly<Record<PaletteKind, number>> = { page: PAGES.length, pillar: 12, requirement: 12 };

/**
 * The results for a query, grouped.
 *
 * Order within a group is match quality and then identity, and never the run: a requirement does not
 * move up this list for failing. That is the opposite of the overview's queue, on purpose. A queue is
 * an argument about what to do first and is allowed to change between runs; a navigator is a way to
 * reach a thing you already have in mind, and a row that moves because the estate changed overnight
 * is a row the reader's fingers can no longer find.
 */
export function paletteResults(entries: readonly PaletteEntry[], query: string): readonly PaletteGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  /*
   * An empty query answers with the pages, in the order the rail declares them rather than
   * alphabetically. A palette that opens blank has to be learned from somewhere else; one that opens
   * showing where it can take you teaches itself in the pause before the reader starts typing — and
   * what it should teach is the app's own structure, which is what that order is. Sorting is for a
   * reader who has typed a word and is looking for it.
   */
  if (words.length === 0) return grouped(entries.filter((entry) => entry.kind === 'page'));

  const found = entries.filter((entry) => words.every((word) => entry.terms.includes(word)));
  return grouped([...found].sort((a, b) => rank(a, words) - rank(b, words) || a.label.localeCompare(b.label)));
}

/** The three kinds in one order, each capped, each saying what the cap left out. */
function grouped(ranked: readonly PaletteEntry[]): readonly PaletteGroup[] {
  return (['page', 'pillar', 'requirement'] as const)
    .map((kind) => {
      const all = ranked.filter((entry) => entry.kind === kind);
      return {
        kind,
        heading: HEADINGS[kind],
        entries: all.slice(0, CAP[kind]),
        hidden: Math.max(0, all.length - CAP[kind]),
      };
    })
    .filter((group) => group.entries.length > 0);
}

/**
 * How well an entry matches, lower being better.
 *
 * Four bands rather than a score. A band is explicable — "you typed its id", "you typed the start of
 * its name" — and a weighted score is not, which matters because the one thing a reader will ask of a
 * palette is why the row they wanted was second.
 */
function rank(entry: PaletteEntry, words: readonly string[]): number {
  const phrase = words.join(' ');
  const label = entry.label.toLowerCase();
  // The id, for a requirement. Typed in full it is unambiguous and belongs above everything.
  const id = entry.id.slice(entry.id.indexOf(':') + 1).toLowerCase();

  if (id === phrase) return 0;
  if (label === phrase) return 1;
  if (label.startsWith(phrase)) return 2;
  if (id.startsWith(phrase)) return 3;
  if (label.includes(phrase)) return 4;
  return 5;
}

/**
 * Where the palette sends a query it could not place, and the words to put on that row.
 *
 * A palette with a dead end teaches the reader not to use it. The findings page has a free-text
 * filter over titles, criteria and evidence, so a phrase this file cannot match is not a phrase the
 * app cannot answer — it is a phrase for the surface that searches inside requirements rather than
 * across them.
 */
export function searchElsewhere(query: string): { readonly to: string; readonly label: string } | undefined {
  const trimmed = query.trim();
  if (trimmed === '') return undefined;
  return {
    to: `/findings?q=${encodeURIComponent(trimmed)}`,
    label: `Search every requirement for “${trimmed}”`,
  };
}
