/** The exact filtered work list a low-evidence score card opens. */
export function evidenceGapPath(pillarId?: string): string {
  return pillarId == null
    ? '/investigate?outcome=unmeasurable'
    : `/investigate?outcome=unmeasurable&pillar=${encodeURIComponent(pillarId)}`;
}
