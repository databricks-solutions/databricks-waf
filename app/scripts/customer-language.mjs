/**
 * Delivery vocabulary that may never become customer-facing content in the served pilot.
 *
 * Control ids, dates and record ids are legitimate product provenance. Pull-request numbers and
 * plan-row ids joined to words such as "labs journey" are implementation provenance: they explain
 * our work, not the customer's assessment. This is deliberately a served-release check rather than
 * input validation; a customer remains free to name their own assessment.
 */
import internalDeliveryPatterns from '../shared/api/internal-delivery-patterns.json' with { type: 'json' };

const INTERNAL_DELIVERY_LABELS = Object.freeze(internalDeliveryPatterns.map((pattern) => new RegExp(pattern, 'giu')));

/**
 * @param {string} text
 * @returns {string[]}
 */
export function internalDeliveryLabels(text) {
  const found = new Set();
  for (const pattern of INTERNAL_DELIVERY_LABELS) {
    for (const match of text.matchAll(pattern)) found.add(match[0]);
  }
  return [...found];
}
