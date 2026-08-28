const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

/**
 * Customer-hierarchy failures read from one rendered route.
 *
 * Geometry checks can prove that a page fits while the customer still sees two empty panes, a
 * technical identifier as the title, or a recommendation whose action is below the evidence. This
 * check deliberately reads semantic markers rather than page names so a new route inherits the same
 * contract on the day it enters the router.
 *
 * @param {{
 *   headings: readonly string[];
 *   emptyCount: number;
 *   primaryActionLabels: readonly string[];
 *   recommendations: readonly {
 *     text: string;
 *     destinationCount: number;
 *     beforeSupport: boolean;
 *     inFirstViewport: boolean;
 *   }[];
 * }} reading
 * @returns {string[]}
 */
export function customerHierarchyProblems(reading) {
  const problems = [];

  if (reading.emptyCount > 1) {
    problems.push(`renders ${String(reading.emptyCount)} empty states instead of one actionable composition`);
  }

  if (reading.headings.some((heading) => UUID.test(heading))) {
    problems.push('uses a UUID as a customer heading');
  }

  const actions = reading.primaryActionLabels.map((label) => label.trim()).filter((label) => label !== '');
  const repeated = [...new Set(actions.filter((label, index) => actions.indexOf(label) !== index))];
  for (const label of repeated) problems.push(`repeats the primary action “${label}”`);

  for (const [index, recommendation] of reading.recommendations.entries()) {
    const name = `recommendation ${String(index + 1)}`;
    if (!/\bDo this\b/i.test(recommendation.text)) problems.push(`${name} does not lead with “Do this”`);
    if (!/\bWhy\b/i.test(recommendation.text)) problems.push(`${name} does not explain “Why”`);
    if (recommendation.destinationCount === 0) problems.push(`${name} has no exact destination or in-app handoff`);
    if (!recommendation.beforeSupport) problems.push(`${name} follows its supporting metrics or evidence`);
    if (index === 0 && !recommendation.inFirstViewport)
      problems.push('the first recommendation begins below the viewport');
  }

  return problems;
}
