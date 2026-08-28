// Types for `schedule-principal.mjs`, which stays JavaScript because it is a plain Node tool run
// straight from source against a real workspace, with no build step in front of it.

/** The catalogue the system tables sit in. */
export const SYSTEM_CATALOG: string;

/** Schemas under `system` that no grant makes readable, mapped to why. */
export const NOT_GRANTABLE: Readonly<Record<string, string>>;

/** What a schema grant has to carry for the statements to run. */
export const SCHEMA_PRIVILEGES: readonly string[];

/** What this deliberately never asks for, as sentences a reviewer can read. */
export const WITHHELD: readonly string[];

/** What a customer catalog is granted where the operator asks for estate visibility. */
export const CATALOG_PRIVILEGE: string;

/** The four metastore grants `--sharing` asks for, and what each one makes countable. */
export const SHARING_PRIVILEGES: readonly { readonly privilege: string; readonly counts: string }[];

/** Which catalogs are the customer's, as `server/collect/sql/queries.ts` decides it. */
export function customerCatalogPredicate(column: string): string;

/** The statement that derives the customer catalogs, rather than a list somebody maintains. */
export function customerCatalogsQuery(): string;

/** Which catalogs `--catalogs` asked for, against the derived set. Throws on one outside it. */
export function catalogsAsked(argv: readonly string[], derived: readonly string[]): string[];

/** A SCIM `eq` filter, with the value quoted and escaped as SCIM requires. */
export function scimFilter(attribute: string, value: string): string;

/** One statement as read from the tree. */
export interface Statement {
  readonly name: string;
  readonly sql: string;
}

/** One thing the scheduled run's identity needs. */
export interface Need {
  readonly id: string;
  readonly what: string;
  readonly why: string;
  readonly kind: 'membership' | 'permission' | 'grant';
  /** The SQL that would make it so, present only for `kind: 'grant'`. */
  readonly statement?: string;
  /** The SQL that takes it back, present wherever `statement` is. */
  readonly undo?: string;
}

/** One need, placed against what the workspace already holds. */
export interface Settled extends Need {
  readonly held: boolean;
}

/** SQL with comments stripped, so a schema named only in a comment is not read as a grant. */
export function withoutComments(sql: string): string;

/** Every schema under `system` the given statements read, sorted and deduplicated. */
export function schemasRead(statements: readonly Statement[]): string[];

/** The schemas a grant can widen, and the ones it cannot, kept apart. */
export function grantableSchemas(schemas: readonly string[]): {
  readonly grantable: string[];
  readonly ungrantable: string[];
};

/** The derived grantable schemas divided by what this workspace currently offers. */
export function partitionAvailableSchemas(
  schemas: readonly string[],
  listed: readonly string[]
): {
  readonly present: string[];
  readonly unavailable: string[];
};

/** Read held schema grants while tolerating a schema disappearing after discovery. */
export function schemaGrantsHeld(
  schemas: readonly string[],
  read: (schema: string) => readonly string[]
): {
  readonly held: Readonly<Record<string, boolean>>;
  readonly unavailable: string[];
};

/** Reconcile discovery with later grant reads before any need or statement is built. */
export function reconcileSchemaAvailability(
  discovered: { readonly present: readonly string[]; readonly unavailable: readonly string[] },
  grantReading: { readonly unavailable: readonly string[] }
): {
  readonly present: string[];
  readonly unavailable: string[];
};

/** Everything the identity needs, in the order a reader should check it. */
export function needsOf(where: {
  readonly principal: string;
  readonly group: string;
  readonly app: string;
  readonly warehouse: string;
  readonly schemas: readonly string[];
  /** Empty unless the operator asked for estate visibility with `--catalogs`. */
  readonly catalogs?: readonly string[];
  /** False unless the operator asked for the sharing census with `--sharing`. */
  readonly sharing?: boolean;
}): Need[];

/** Each need placed against what the workspace says is already there. */
export function standing(needs: readonly Need[], holds: (need: Need) => boolean): Settled[];

/** The report, as lines. */
export function lines(reading: {
  readonly principal: string;
  readonly profile: string;
  readonly settled: readonly Settled[];
  readonly applied: readonly string[];
  readonly ungrantable: readonly string[];
  /** Databricks-managed schemas that this workspace did not expose when checked. */
  readonly unavailable?: readonly string[];
  /** The derived customer set, so a run that asked for none can still say the option exists. */
  readonly catalogs?: readonly string[];
}): string[];

/** The teardown report: what `--revoke` will remove, or what it removed. */
export function removalLines(reading: {
  readonly principal: string;
  readonly profile: string;
  readonly settled: readonly Settled[];
  readonly removed: readonly string[];
  /** Databricks-managed schemas that this workspace did not expose when checked. */
  readonly unavailable?: readonly string[];
}): string[];

/** Every statement in the tree, as this reads them. */
export function statementsIn(directory?: string): Statement[];
