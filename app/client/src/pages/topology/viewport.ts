/**
 * The minimum scale at which topology labels are product content rather than overview marks.
 *
 * The node name is 14 CSS pixels at this scale. A whole-estate overview remains available through
 * Fit View, but opening and selection never make a person decipher scaled-down labels.
 */
export const READABLE_GRAPH_ZOOM = 1;

export function readableSelectionZoom(currentZoom: number): number {
  return Math.max(currentZoom, READABLE_GRAPH_ZOOM);
}
