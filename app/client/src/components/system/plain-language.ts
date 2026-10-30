// The plain-language layer: an everyday phrase for each domain term, with the precise term kept.
//
// This tool has to be read by someone who does not know what a pillar or an attestation is, and by
// someone who does and would be slowed down by having those words spelled out. The map pairs each
// precise term with the plain phrase a page leads with; the precise term never goes away — it rides
// along on hover and focus through the Term helper's title — so the plain reading is the default and
// the exact one is a pointer away.
//
// Written with createElement rather than JSX so this stays a .ts module: it is a vocabulary first and
// a component second, and most of it is imported for the words, not the element.

import { createElement, type ReactElement } from 'react';

export interface TermEntry {
  /** The everyday phrase shown to every reader by default. */
  readonly plain: string;
  /** The precise term, kept for technical readers and always reachable on hover and focus. */
  readonly precise: string;
  /** A one-line gloss, folded into the tooltip where it helps. */
  readonly hint?: string;
}

export type TermId =
  | 'pillar'
  | 'finding'
  | 'requirement'
  | 'control'
  | 'attestation'
  | 'evidence'
  | 'coverage'
  | 'unmeasurable'
  | 'provenance'
  | 'differential';

/**
 * Precise term to plain phrase. The plain side is what a page says first; the precise side is what a
 * technical reader confirms by hovering. Keep both — dropping the precise term is how a tool that set
 * out to be readable stops being accurate.
 */
export const terms: Readonly<Record<TermId, TermEntry>> = {
  pillar: { plain: 'focus area', precise: 'Pillar', hint: 'one of the framework’s focus areas' },
  finding: { plain: 'check result', precise: 'Finding', hint: 'what a single check found' },
  requirement: { plain: 'check', precise: 'Requirement', hint: 'one thing the assessment checks' },
  control: { plain: 'check', precise: 'Control', hint: 'one thing the assessment checks' },
  attestation: { plain: 'your confirmation', precise: 'Attestation', hint: 'a practice you confirm in writing' },
  evidence: { plain: 'what we checked', precise: 'Evidence', hint: 'the readings a result is based on' },
  coverage: { plain: 'how much we measured', precise: 'Coverage', hint: 'the share of a check we could measure' },
  unmeasurable: {
    plain: 'couldn’t check automatically',
    precise: 'Unmeasurable',
    hint: 'not something platform data can answer on its own',
  },
  provenance: { plain: 'where the data came from', precise: 'Provenance', hint: 'the source of a reading' },
  differential: { plain: 'what changed', precise: 'Differential', hint: 'what changed since the last assessment' },
};

/** The plain phrase for a term. */
export function plainTerm(id: TermId): string {
  return terms[id].plain;
}

/** The precise term. */
export function preciseTerm(id: TermId): string {
  return terms[id].precise;
}

export interface TermProps {
  readonly id: TermId;
  /** Show the precise term rather than the plain phrase. Both stay reachable on hover and focus. */
  readonly precise?: boolean;
  readonly className?: string;
}

/**
 * Renders a term's plain phrase (or its precise form) with the precise term and gloss on its title,
 * so a reader who wants the exact word gets it by hovering or focusing without the page having to
 * spell it out inline.
 */
export function Term({ id, precise = false, className }: TermProps): ReactElement {
  const entry = terms[id];
  const shown = precise ? entry.precise : entry.plain;
  const title = entry.hint != null ? `${entry.precise} — ${entry.hint}` : entry.precise;

  return createElement(
    'span',
    {
      className: className != null ? `wa-term ${className}` : 'wa-term',
      title,
      'data-term': id,
    },
    shown
  );
}
