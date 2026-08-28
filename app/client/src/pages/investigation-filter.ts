export function updatedInvestigationParams(
  current: URLSearchParams,
  entries: Readonly<Record<string, string | undefined>>
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(entries)) {
    // An absent outcome means the actionable default (unmet), so `all` is meaningful for this
    // filter. Pillar and movement still use absence as their all-values default.
    if (value == null || value === '' || (value === 'all' && key !== 'outcome')) next.delete(key);
    else next.set(key, value);
  }
  return next;
}
