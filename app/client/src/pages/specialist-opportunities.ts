/**
 * Primary specialist lists are work queues, not analyzer inventories.
 *
 * Clean, ineligible and unmeasured rows still contribute to the coverage sentences above the list, but
 * only a row carrying at least one non-informational finding belongs in the selectable work area.
 */
type SpecialistFinding = { readonly severity: 'critical' | 'high' | 'medium' | 'info' };

function hasActionableFinding(findings: readonly SpecialistFinding[]): boolean {
  return findings.some((finding) => finding.severity !== 'info');
}

export function actionableRows<T extends { readonly findings: readonly SpecialistFinding[] }>(
  rows: readonly T[]
): readonly T[] {
  return rows.filter((row) => hasActionableFinding(row.findings));
}

/**
 * Workloads arrive in two ranked projections. Keep every actionable shape once, preserving the cost-first
 * order and then adding actionable failure-ranked shapes that were outside that projection.
 */
export function actionableWorkloads<
  T extends { readonly workspaceId: string; readonly shape: string; readonly findings: readonly SpecialistFinding[] },
>(top: readonly T[], failing: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return [...top, ...failing].filter((row) => {
    if (!hasActionableFinding(row.findings)) return false;
    const key = `${row.workspaceId}:${row.shape}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
