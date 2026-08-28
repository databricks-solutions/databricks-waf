// A readable label for a pillar identifier the catalogue does not hold.
//
// The provider's fallback used to be the identifier itself, which put a lowercase slug into an <h1>
// and a breadcrumb: "security-compliance-and-privacy" where a stale link named a pillar that has
// since been renamed, or "security" where one was typed by hand. Both happen, and the header renders
// before the page has established whether the pillar exists, so the header needs an answer that is
// presentable whether or not it turns out to be a real pillar.

/**
 * Sentence case, hyphens as spaces. Deliberately not title case: the catalogue's own titles are
 * sentence case ("Cost optimization", "Data and AI governance"), so this reads as a title the
 * framework could plausibly have rather than as a slug that has been dressed up.
 */
export function readablePillarId(pillarId: string): string {
  const words = pillarId.replaceAll('-', ' ').replaceAll('_', ' ').trim();
  if (words.length === 0) return 'Unknown pillar';
  return words[0].toUpperCase() + words.slice(1);
}
