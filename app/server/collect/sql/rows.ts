// Coercion for warehouse rows.
//
// The Statement Execution API's JSON_ARRAY format returns every value as a
// string: a BIGINT arrives as "141", a BOOLEAN as "true", a DECIMAL as
// "16137.07". Read those without coercing and `count > 0` is true for "0",
// `bytes + bytes` concatenates, and a threshold comparison silently compares
// strings lexicographically — "9" > "10".
//
// So coercion happens once, here, at the boundary. Resolvers never see a raw row.

/** A row as delivered by AppKit: column name to stringified value, or null. */
export type Row = Record<string, unknown>;

/**
 * Each column's Databricks type, by name, from the result manifest.
 *
 * Carried because the values cannot be trusted to reveal it. Every one arrives as a string, so a
 * BIGINT count and a STRING id holding digits are the same bytes — and they sort differently, one
 * numerically and one byte by byte. Nothing needs this until rows from two responses have to be put
 * back in the order one response would have had them in; see concat.ts.
 */
export type ColumnTypes = Readonly<Record<string, string>>;

/**
 * Whether a column sorts as a number.
 *
 * The type names the Statement Execution API reports for its numeric types. `INTERVAL` and the date
 * types are deliberately absent: they sort correctly as text in the ISO-8601 form the API returns
 * them in, and `Number()` of one is `NaN`, which would sort every value equal.
 */
const NUMERIC_TYPES = new Set(['BYTE', 'SHORT', 'INT', 'INTEGER', 'LONG', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL']);

export function isNumericType(type: string | undefined): boolean | undefined {
  if (type == null || type === '') return undefined;
  return NUMERIC_TYPES.has(type.toUpperCase());
}

export function text(row: Row, column: string): string | undefined {
  const value = row[column];
  if (value == null) return undefined;
  // Only the scalar types the API actually delivers. A struct or array column would
  // stringify to "[object Object]", which reads like a value and compares like one, so
  // it is refused instead — a query returning one here is a query bug, not a value.
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

/**
 * A number, or undefined when the column is null or unparseable.
 *
 * Undefined rather than zero, because the two mean different things and the
 * difference is exactly what the unpopulated-column problem turns on: a NULL
 * `timeout_seconds` means the system table has not recorded one, and reading it
 * as zero would report every long-standing job as having no timeout.
 */
export function num(row: Row, column: string): number | undefined {
  const value = row[column];
  if (value == null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A number with a floor of zero for genuine counts, where absent means none. */
export function count(row: Row, column: string): number {
  return num(row, column) ?? 0;
}

export function bool(row: Row, column: string): boolean | undefined {
  const value = row[column];
  if (value == null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const lower = text(row, column)?.toLowerCase();
  if (lower === 'true' || lower === 't' || lower === '1') return true;
  if (lower === 'false' || lower === 'f' || lower === '0') return false;
  return undefined;
}

export function date(row: Row, column: string): Date | undefined {
  const value = text(row, column);
  if (value == null) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Fraction with an explicit zero-denominator answer, so callers cannot produce NaN. */
export function share(part: number, whole: number): number | undefined {
  if (whole <= 0) return undefined;
  return part / whole;
}
