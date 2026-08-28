// Which assessment a product read is of.
//
// Stores are singletons created at boot, so the assessment cannot be bound at construction. Every
// product read takes a scope as an argument. `undefined` is the installation operating on itself —
// digest verification, the retention sweep, a scheduled job fetching by idempotency key, an author's
// list of every unfinished draft — and those paths omit the argument. A string is that definition.
// `null` is records that name none: a run started without an assessment, an answer given the same way.
//
// Null is not "the install's". ADR 0080 and the column's own comment both say a record is never
// guessed into a scope, and a missing query parameter is the reader not having named one, which is
// the unscoped view rather than every assessment at once.

/** `string` is that definition; `null` is records that name none. Omit for installation-wide reads. */
export type AssessmentScope = string | null;

/**
 * Adds a `definition_id` predicate to a where-fragment, leaving `order by` where it was.
 *
 * The fragment is what the stores already pass: `where id = $1`, `where month = $1 order by
 * published_at asc`, or empty. Placeholders already in `values` keep their numbers; a scoped
 * equality binds the next one.
 */
export function applyScope(
  fragment: string,
  values: readonly unknown[],
  scope: AssessmentScope | undefined
): { readonly fragment: string; readonly values: readonly unknown[] } {
  if (scope === undefined) return { fragment, values };

  const clause = scope === null ? 'definition_id is null' : `definition_id = $${String(values.length + 1)}`;
  const extra: readonly unknown[] = scope === null ? [] : [scope];
  const order = /\border by\b/i.exec(fragment);
  const before = (order == null ? fragment : fragment.slice(0, order.index)).trim();
  const after = order == null ? '' : fragment.slice(order.index);
  const where = before === '' ? `where ${clause}` : `${before} and ${clause}`;
  return { fragment: after === '' ? where : `${where} ${after}`, values: [...values, ...extra] };
}

/** Whether a stored key belongs to this read. Empty-string keys are the drafts' spelling of none. */
export function inScope(definitionId: string | null | undefined, scope: AssessmentScope | undefined): boolean {
  if (scope === undefined) return true;
  if (scope === null) return definitionId == null || definitionId === '';
  return definitionId === scope;
}

/**
 * The assessment a write is under, stamped onto the record.
 *
 * `null` leaves it unnamed — an unstamped run, an answer given the same way. A string is that
 * definition. The column is never guessed from another record.
 */
export function stamped<T extends object>(record: T, scope: AssessmentScope): T {
  return scope == null ? record : { ...record, definitionId: scope };
}
