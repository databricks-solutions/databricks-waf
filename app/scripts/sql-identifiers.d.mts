// Types for `sql-identifiers.mjs`, which stays JavaScript so the scheduled-principal tool can
// import it under plain Node with no build step.

/** A Databricks SQL identifier, backtick-quoted, or undefined when it must not be emitted. */
export function quoteIdent(value: string | null | undefined): string | undefined;

/** Whether a string is a Databricks service-principal application id (a UUID). */
export function isApplicationId(value: string | null | undefined): boolean;

/** The generators that interpolate an identifier into Databricks SQL, read by the test and the gate. */
export const GENERATED_SQL_FAMILIES: readonly { readonly id: string; readonly path: string }[];
