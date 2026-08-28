// A short label per pillar, for places 204px wide.
//
// The chrome column lists all seven pillars, which is what the reference does and what makes the
// framework's shape visible without reading a page. The official titles do not fit: "Security,
// compliance, and privacy" in a 204px column at 12px truncates to "Security, compliance, an…",
// and a navigation whose labels end in an ellipsis is one the reader has to click to identify.
//
// The previous answer was to delete the pillar list. This is the better one: the chrome says
// Security, the page header and the pillar matrix say the official title in full, and the title
// attribute carries it for anyone hovering. Nothing is renamed — the official title remains the
// only one shown anywhere a reader could quote it.

// A soft hyphen, U+00AD. Invisible unless the line has to break there, which is the only
// difference between it and a hyphen.
const SHY = '\u00AD';

/*
 * Six of the seven short names contain a space, so a box too narrow for them wraps onto a second
 * line. "Interoperability" contains none. At 12px semibold it wants 97px, a score card gives its
 * label 85, and a two-line clamp with nothing to break on cuts the word mid-letter with no ellipsis
 * to say so — "Interoperabilit" shipped on the overview looking like a rendering fault rather than
 * an abbreviation. A soft hyphen at the morpheme gives the break somewhere to happen: "Inter-" over
 * "operability", both of which fit. Where the box is wide enough — the chrome column, a finding's
 * pillar tag — nothing renders and the name is whole.
 */
const SHORT: Readonly<Record<string, string>> = {
  'cost-optimization': 'Cost',
  'data-and-ai-governance': 'Data & AI governance',
  'interoperability-and-usability': `Inter${SHY}operability`,
  'operational-excellence': 'Operational excellence',
  'performance-efficiency': 'Performance',
  reliability: 'Reliability',
  'security-compliance-and-privacy': 'Security',
};

/**
 * The short form, or the full title where a pillar arrives that this does not know about — an
 * unknown pillar is better truncated than silently renamed to something invented.
 */
export function shortPillarLabel(pillarId: string, title: string): string {
  return SHORT[pillarId] ?? title;
}
