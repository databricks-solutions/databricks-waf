/**
 * The action panel is a decision surface, not the full assessment narrative.
 *
 * A resolver's outcome reason can carry several evidence qualifications because it is also used in
 * reports. The first sentence is the evidence-bounded reason to act; the complete observation,
 * expectation, requirement intent and implementation caveats remain immediately below the action.
 * Keeping the sentence verbatim avoids manufacturing a conclusion the finding did not carry.
 */
export function findingActionReason(outcomeReason: string | undefined, rationale: string | undefined): string {
  const reason = outcomeReason ?? rationale ?? 'The published report does not meet this requirement.';
  const boundary = reason.search(/[.!?](?:\s|$)/);
  return boundary === -1 ? reason.trim() : reason.slice(0, boundary + 1).trim();
}
