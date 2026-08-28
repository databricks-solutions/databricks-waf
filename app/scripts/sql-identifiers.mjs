// One rule for every identifier interpolated into Databricks SQL this app generates.
//
// The rule exists because generated SQL is pasted into privileged sessions or executed as the
// scheduled principal. A backtick left undoubled closes the identifier early; a newline has no
// escape inside an identifier and turns one statement into two. Preflight already held this for
// GRANT identities; the scheduled-principal tool and the per-table describe did not share a module,
// so the three drifted. They do not any more.
//
// Used from both TypeScript (via the `.mjs` import the rest of the scripts already use) and from
// `schedule-principal.mjs`, which runs under plain Node and cannot import `.ts`.

/**
 * A Databricks SQL identifier, backtick-quoted, or undefined when it must not be emitted.
 *
 * Backticks inside the value are doubled. A line break or an empty/whitespace-only value is refused
 * rather than escaped: there is no escape for a newline inside an identifier, and emitting a
 * multi-line grant captioned "runnable as written" is worse than emitting nothing.
 *
 * @param {string | null | undefined} value
 * @returns {string | undefined}
 */
export function quoteIdent(value) {
  if (value == null) return undefined;
  const text = String(value);
  if (text.trim() === '' || /[\r\n]/.test(text)) return undefined;
  return `\`${text.replaceAll('`', '``')}\``;
}

/**
 * Whether a string is a Databricks service-principal application id (a UUID).
 *
 * The scheduled-principal tool documents `--client-id` as an application id. Accepting an arbitrary
 * string and interpolating it into `SHOW GRANTS` / `GRANT` would turn a mistyped flag into SQL; the
 * UUID shape is what the platform issues and what the tool promises to take.
 *
 * @param {string | null | undefined} value
 * @returns {boolean}
 */
export function isApplicationId(value) {
  if (value == null) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

/**
 * The generators that interpolate an identifier into Databricks SQL.
 *
 * One list, read by `sql-identifiers.test.ts` — which walks `scripts` and `server` for the pattern
 * that builds an identifier by hand and fails on a site not listed here — and by
 * `check-sql-release.mjs`, which checks each path still resolves. It lived in both of those and in a
 * third copy in the gate, whose comment claimed that a family added without being listed would fail
 * the gate. It could not: a family absent from a list the gate iterates is a family the gate does not
 * look at. The tree walk is what catches an unlisted one, and it is in the test.
 *
 * Lakebase/Postgres SQL is out of scope: it parameterises values rather than interpolating
 * identifiers.
 *
 * @type {readonly { readonly id: string; readonly path: string }[]}
 */
export const GENERATED_SQL_FAMILIES = [
  { id: 'quoteIdent', path: 'scripts/sql-identifiers.mjs' },
  { id: 'schedule-principal', path: 'scripts/schedule-principal.mjs' },
  { id: 'preflight', path: 'server/define/preflight.ts' },
  { id: 'describe', path: 'server/collect/sql/describe.ts' },
  { id: 'predictive-optimization', path: 'server/collect/sql/predictive-optimization.ts' },
  { id: 'hash-bucketing', path: 'server/collect/sql/buckets.ts' },
];
