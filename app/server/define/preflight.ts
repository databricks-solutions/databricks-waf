// Whether this assessment can actually run, asked before it is run.
//
// The app's failure mode without this is not an error, which is what makes it worth a module. A
// scan against an under-granted identity completes: every check whose table the identity cannot
// read reports itself unmeasured, the score is computed from what remains, and the reader gets a
// number. It is a number about a fraction of their estate, arrived at by a method they were not
// told had partly failed, and the only sign is a count of unmeasured requirements that looks like
// this app's own backlog — which most of it genuinely is.
//
// So the grants are checked first, and the two things the check has to get right are both about
// precision.
//
// **The exact grant, not "a permission problem".** The app already knows which tables each check
// reads, because `tablesRead` derives it from the statement rather than from a list beside it. That
// means a denial can be reported as the line somebody runs to fix it. Today the same denial during
// a scan says "grant SELECT on the relevant system schema", which is a sentence that sends a
// metastore admin to find out which — and there are five.
//
// **The identity, not the app.** The probe runs on the token the scan would run on, because that is
// the only thing that answers the question. The app's own service principal being able to read
// `system.billing` is not evidence that the person about to press the button can, and ADR 0016 is
// the record of this project having assumed the equivalent once already.
//
// What this deliberately does not do is guess. A probe that fails for a reason other than
// permission — the schema is not enabled on this metastore, the warehouse is asleep, the network
// refused — is reported as what it was, not as a missing grant. A wrong grant instruction is worse
// than none: the admin runs it, nothing changes, and they have learnt to ignore the next one.

import {
  currentVersion,
  resolveScope,
  type AssessmentDefinition,
  type Measurement,
  type ScopeResolution,
} from './definition.js';
import { schemaOf } from '../collect/sql/reads.js';
import type { Catalogue } from '../catalogue/catalogue.js';
import type { SignalId } from '../collect/signal.js';
import type { WorkspaceDirectory } from '../collect/sql/shapes.js';
import type { SignalDescriptor } from '../plan/descriptors.js';
import { quoteIdent } from '../../scripts/sql-identifiers.mjs';
import type { Digest } from '../records/digest.js';
import type { ResolverRegistry } from '../resolve/resolver.js';

/** What a probe of one table turned out to be. */
export type Reading =
  /** The statement ran. Every check behind this table can read it. */
  | 'readable'
  /** Refused on permission. A grant would fix it, and the grant is named. */
  | 'denied'
  /**
   * The table is not there.
   *
   * Distinct from `denied` because the response is different and the remedy is not a grant: a system
   * schema has to be enabled on the metastore before anything can be granted on it, and telling an
   * admin to `GRANT SELECT` on a schema that does not exist wastes their time twice.
   */
  | 'absent'
  /** Something else. Nothing is concluded, and the platform's own words are carried through. */
  | 'unknown';

export interface ProbedSource {
  /** The three-part name, as the statement wrote it. */
  readonly table: string;
  /** Where a grant would be made: `system.billing` for `system.billing.usage`. */
  readonly schema: string;
  readonly reading: Reading;
  /** The platform's own words, or a sentence saying the probe answered. */
  readonly detail: string;
  /** Runnable, and only present for a denial. See `grantFor`. */
  readonly grant?: string;
  /** The checks that read this table and so cannot run without it, sorted. */
  readonly blocks: readonly string[];
}

/**
 * A check the assessment includes and that will not produce a result.
 *
 * `needs` is the grants rather than the tables, because the reader of this is deciding what to ask
 * for. Two checks blocked on the same schema should read as one request, and they will: the grant
 * text is identical, so the page can group on it.
 */
export interface BlockedCheck {
  readonly controlId: string;
  readonly pillarId: string;
  readonly needs: readonly string[];
}

/**
 * What a check reads, in the terms the preflight needs.
 *
 * Passed in rather than derived here, because the derivation is `buildPlan`'s and doing it twice is
 * how two surfaces come to disagree about what a scan executes.
 */
export interface CheckSources {
  readonly controlId: string;
  readonly pillarId: string;
  /** Every signal whose absence leaves this check without an outcome. */
  readonly signals: readonly SignalId[];
}

export interface SignalSources {
  readonly id: SignalId;
  /** Three-part table names. A signal reading no system table contributes none. */
  readonly tables: readonly string[];
}

export interface PreflightInput {
  readonly definition: AssessmentDefinition;
  /** The identity the probe ran as, as the platform names it. Used in the grant text. */
  readonly identity: string;
  /** Every check the assessment includes, after the pillar filter has been applied. */
  readonly checks: readonly CheckSources[];
  readonly signals: readonly SignalSources[];
  /**
   * The account directory, when one could be read.
   *
   * Optional because the directory is itself behind a grant, and a preflight whose first probe fails
   * still has to report the rest. Absent resolves to a scope that says the directory could not be read,
   * rather than to an empty estate — which would blame the estate for a permission error.
   */
  readonly directory?: WorkspaceDirectory;
  /** Why the directory is absent, in the platform's terms, so the scope can quote it. */
  readonly directoryUnreadable?: string;
}

export interface Preflight {
  readonly ranAt: Date;
  readonly ranAs: string;
  /** The version this was run against, so a report cannot be read as covering a later revision. */
  readonly definitionId: string;
  readonly version: number;
  readonly fingerprint: Digest;
  readonly sources: readonly ProbedSource[];
  readonly blocked: readonly BlockedCheck[];
  /** Checks in the assessment whose signals can all be read. */
  readonly ready: number;
  /**
   * What the definition's scope came to.
   *
   * Always present. When the directory could not be read the resolution carries `undeterminedReason` and
   * empty sets, which is a statement this report can print; an absent scope was a statement it could not.
   */
  readonly scope: ScopeResolution;
  /** What the reader should take from this, in one sentence. */
  readonly verdict: string;
}

const NOT_YET_RESOLVED =
  'No scan has read the account directory to resolve the scope against, so how much of the estate this ' +
  'covers is not known yet.';

/** Runs one cheap read against a table, resolving on success and throwing what the platform said. */
export type Probe = (table: string) => Promise<void>;

/**
 * A statement that reads nothing and proves the read is allowed.
 *
 * `WHERE false` rather than `LIMIT 0`. Both return no rows, and a permission check happens during
 * analysis either way — but `LIMIT 0` is the form AppKit uses to validate its own queries at
 * startup, and reusing it here would make a preflight execution indistinguishable from a startup
 * validation in the customer's query history. `WHERE false` also survives a table whose statistics
 * make the planner short-circuit differently.
 */
export function probeStatement(table: string): string {
  return `SELECT 1 FROM ${table} WHERE false`;
}

/**
 * The grant that would fix a denial, as a line somebody can run.
 *
 * At schema level, because that is the unit `GRANT SELECT` is used at on system tables and because a
 * reader given eleven table grants across five schemas will ask for the schemas anyway. The identity
 * is backtick-quoted: these are email addresses and service principal ids, and an unquoted one is a
 * syntax error the admin has to debug before they can help.
 *
 * The identity reaches here from a request header, and this app's output is a statement it tells
 * somebody to run. Those two facts together mean the quoting has to hold: a backtick inside the value
 * would close the identifier early and leave whatever followed as SQL a metastore admin pastes into a
 * privileged session. Backticks are doubled, which is how Databricks escapes one inside a quoted
 * identifier, so the value stays a single token whatever it contains.
 *
 * A line break is refused rather than escaped. There is no escape for one inside an identifier, an
 * identity containing one is not a principal any platform issued, and a multi-line grant in a panel
 * captioned "runnable as written" is a worse thing to emit than nothing.
 */
export function grantFor(schema: string, identity: string): string | undefined {
  const quoted = quoteIdent(identity);
  if (quoted == null) return undefined;
  return `GRANT SELECT ON SCHEMA ${schema} TO ${quoted}`;
}

/**
 * Which reading a failure is, from what the platform said.
 *
 * On the message rather than a status code for the same reason `rest/reach.ts` classifies on the
 * message: a missing grant and a schema that was never enabled both arrive as a failed statement,
 * and only the text tells them apart. Everything unrecognised is `unknown`, which reports the
 * failure without prescribing a fix — see the note on wrong grant instructions above.
 */
export function readingFor(message: string): Exclude<Reading, 'readable'> {
  const absent = /TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|does not exist|cannot be found|UNRESOLVED_/i.test(message);
  const denied =
    /PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS|does not have\b|requires? .*privilege|access denied|not authorized|unauthorized|\b403\b/i.test(
      message,
    );

  // Both, which is a real message and not a contrived one: Unity Catalog reports a table the caller
  // may not see as not found, deliberately, so that a refusal does not leak what exists. A message
  // carrying both signals is therefore genuinely ambiguous, and neither guess is safe — "enable the
  // system schema" sends somebody to an account admin for a schema that is already enabled, and
  // "ask for a grant" sends them to a metastore admin for a table that is not there. So it concludes
  // nothing and shows the platform's own words, which is what `unknown` is for.
  if (absent && denied) return 'unknown';
  if (absent) return 'absent';
  if (denied) return 'denied';
  return 'unknown';
}

/**
 * Probes every table the assessment's checks read, and reports what that means for the checks.
 *
 * One probe per distinct table rather than per check: nineteen statements read eleven tables, and
 * probing per check would run the same read eight times over. Sequential, because a burst of
 * simultaneous statements at a customer's warehouse is the impoliteness the whole scheduler exists
 * to avoid and this runs on a button press.
 */
export async function preflight(input: PreflightInput, probe: Probe, now: Date = new Date()): Promise<Preflight> {
  const current = currentVersion(input.definition);
  const measurement = current.measurement;

  const tablesBySignal = new Map(input.signals.map((signal) => [signal.id, signal.tables]));
  const blockedBy = new Map<string, Set<string>>();
  for (const check of input.checks) {
    for (const signal of check.signals) {
      for (const table of tablesBySignal.get(signal) ?? []) {
        const behind = blockedBy.get(table) ?? new Set<string>();
        behind.add(check.controlId);
        blockedBy.set(table, behind);
      }
    }
  }

  const sources: ProbedSource[] = [];
  for (const table of [...blockedBy.keys()].sort()) {
    sources.push({
      ...(await probeOne(table, probe, input.identity)),
      blocks: [...(blockedBy.get(table) ?? [])].sort(),
    });
  }

  const unreadable = new Set(sources.filter((source) => source.reading !== 'readable').map((source) => source.table));
  const grantByTable = new Map(sources.flatMap((source) => (source.grant != null ? [[source.table, source.grant]] : [])));

  const blocked: BlockedCheck[] = [];
  let ready = 0;
  for (const check of input.checks) {
    // Any, not every. A resolver's `requires` is conjunctive — every signal in it is needed to reach
    // an outcome, and a resolver missing one returns unmeasurable — so one unreadable table takes
    // the check with it. `plan.ts` uses `every` for the superficially similar `beyondAnyInstall`,
    // which asks a different question: whether any route could ever exist, not whether this identity
    // has one today.
    const missing = check.signals.filter((signal) =>
      (tablesBySignal.get(signal) ?? []).some((table) => unreadable.has(table)),
    );
    if (missing.length > 0) {
      const needs = new Set<string>();
      for (const signal of missing) {
        for (const table of tablesBySignal.get(signal) ?? []) {
          const grant = grantByTable.get(table);
          if (grant != null) needs.add(grant);
        }
      }
      blocked.push({ controlId: check.controlId, pillarId: check.pillarId, needs: [...needs].sort() });
      continue;
    }
    ready += 1;
  }

  // Resolved even when there was no directory. The resolution says so in its own terms, which is more use
  // to an author than the absence of a scope section that gives them nothing to read.
  //
  // The default reason is deliberately not "could not be read". A caller reaching here without a
  // directory usually has not run a scan yet, and the probe above may have just read
  // `workspaces_latest` successfully — a verdict claiming the table was refused in the same paragraph
  // sends the reader to ask for a grant they already hold. A caller that was actually refused passes
  // what the platform said.
  const scope = resolveScope(measurement, input.directory, input.directoryUnreadable ?? NOT_YET_RESOLVED);

  return {
    ranAt: now,
    ranAs: input.identity,
    definitionId: input.definition.id,
    version: current.version,
    fingerprint: current.fingerprint,
    sources,
    blocked: blocked.sort((a, b) => a.controlId.localeCompare(b.controlId)),
    ready,
    scope,
    verdict: verdictFor(sources, blocked, ready, scope, input.identity),
  };
}

async function probeOne(table: string, probe: Probe, identity: string): Promise<Omit<ProbedSource, 'blocks'>> {
  const schema = schemaOf(table);
  try {
    await probe(table);
    return { table, schema, reading: 'readable', detail: 'The read was allowed.' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reading = readingFor(detail);
    // A grant only on `denied`. The other two readings have remedies that are not grants, and
    // offering one anyway is the wrong instruction this module's header argues against. `grantFor`
    // can also decline, for an identity it cannot quote safely, and the denial is still reported —
    // without a line to run, which is honest, rather than with one that is not.
    const grant = reading === 'denied' ? grantFor(schema, identity) : undefined;
    return { table, schema, reading, detail, ...(grant != null ? { grant } : {}) };
  }
}

/**
 * The one sentence a reader takes away, and the one place this module states a judgement.
 *
 * Written as what the run would produce rather than as a status, because "3 sources denied" leaves
 * the reader to work out whether that matters. Whether it matters depends on how many checks sit
 * behind them, and the preflight is the only thing that knows.
 */
function verdictFor(
  sources: readonly ProbedSource[],
  blocked: readonly BlockedCheck[],
  ready: number,
  scope: ScopeResolution,
  identity: string,
): string {
  const total = ready + blocked.length;
  if (sources.length === 0) {
    return 'This assessment includes no checks that read a system table, so there is nothing to authorise.';
  }

  if (blocked.length === 0) {
    return [`Every source this assessment reads answered, so all ${String(total)} of its checks can run.`, coverage(scope)]
      .filter((part) => part !== '')
      .join(' ');
  }

  const grants = new Set(blocked.flatMap((check) => check.needs));
  const unexplained = sources.filter((source) => source.reading === 'unknown').length;
  const absent = sources.filter((source) => source.reading === 'absent').length;

  const parts = [
    `${String(blocked.length)} of ${String(total)} checks in this assessment cannot run as ` +
      `${identity}, and would report themselves unmeasured rather than failing.`,
  ];
  if (grants.size > 0) {
    parts.push(
      `${String(grants.size)} grant${grants.size === 1 ? '' : 's'} would fix ` +
        `${grants.size === 1 ? 'them' : 'most of them'}, listed below and runnable as written.`,
    );
  }
  if (absent > 0) {
    parts.push(
      `${String(absent)} source${absent === 1 ? ' is' : 's are'} not present on this metastore, which is a ` +
        'setting to enable rather than a grant to make.',
    );
  }
  if (unexplained > 0) {
    parts.push(
      `${String(unexplained)} failed for a reason this app does not recognise, so no remedy is offered ` +
        'for it — the platform’s own message is beside it.',
    );
  }
  const covered = coverage(scope);
  if (covered !== '') parts.push(covered);
  return parts.join(' ');
}

/**
 * What the checks would cover, when that is worth a sentence.
 *
 * Silent when the scope is complete: "all of it" adds nothing to a verdict that has already said every
 * check can run. The unresolved case is not special-cased here because the resolution words it — an
 * undetermined directory produces a description that says the coverage was not established, and the
 * caller that knows why the read failed has already passed the reason in.
 */
function coverage(scope: ScopeResolution): string {
  return scope.complete ? '' : scope.description;
}

/** The distinct tables a set of checks reads, for a caller that only wants the probe list. */
export function tablesFor(checks: readonly CheckSources[], signals: readonly SignalSources[]): readonly string[] {
  const tablesBySignal = new Map(signals.map((signal) => [signal.id, signal.tables]));
  const tables = new Set<string>();
  for (const check of checks) {
    for (const signal of check.signals) {
      for (const table of tablesBySignal.get(signal) ?? []) tables.add(table);
    }
  }
  return [...tables].sort();
}

/** Whether a definition's pillar filter includes this pillar. Absent means all of them. */
export function includesPillar(measurement: Measurement, pillarId: string): boolean {
  return measurement.pillars == null || measurement.pillars.includes(pillarId);
}

export interface SourcesOptions {
  readonly catalogue: Catalogue;
  readonly registry: ResolverRegistry;
  readonly descriptors: readonly SignalDescriptor[];
  /** The definition's measurement, so the pillar filter narrows the probe to what will run. */
  readonly measurement: Measurement;
}

/**
 * What the assessment's checks read, derived from the same three things a scan is derived from.
 *
 * The closure over `derivedFrom` is the part that matters and the part a hand-written mapping would
 * have got wrong. Every system-table statement filters on the workspace directory, so every SQL
 * check depends on `system.access.workspaces_latest` whether or not its own statement names it. An
 * identity denied that one table can read all the others and still measure nothing, and a preflight
 * that reported eighteen sources readable and one denied — without saying the one takes the other
 * eighteen with it — would be worse than no preflight, because it looks like a minor gap.
 */
export function sourcesFor(options: SourcesOptions): {
  readonly checks: readonly CheckSources[];
  readonly signals: readonly SignalSources[];
} {
  const byId = new Map(options.descriptors.map((descriptor) => [descriptor.id, descriptor]));

  const signals: SignalSources[] = options.descriptors.map((descriptor) => ({
    id: descriptor.id,
    // Only three-part names. The per-object descriptors describe their work in prose
    // ("DESCRIBE DETAIL on each sampled table"), which is not a table anything can probe.
    tables: descriptor.touches.filter((touched) => /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/i.test(touched)),
  }));

  const checks: CheckSources[] = [];
  for (const control of options.catalogue.controls) {
    if (!includesPillar(options.measurement, control.pillarId)) continue;
    const resolver = options.registry.get(control.id);
    if (resolver == null) continue;
    checks.push({
      controlId: control.id,
      pillarId: control.pillarId,
      signals: closureOf(resolver.requires, byId),
    });
  }

  return { checks, signals };
}

/**
 * A signal set plus everything those signals are derived from, to a fixed point.
 *
 * Iterated rather than one pass, for the reason `plan.ts` gives for the same closure: an input can
 * have an input, and one pass would satisfy today's two-step chains and silently drop the first
 * three-step one.
 */
function closureOf(
  requires: readonly SignalId[],
  byId: ReadonlyMap<SignalId, SignalDescriptor>,
): readonly SignalId[] {
  const needed = new Set<SignalId>(requires);
  for (let added = true; added; ) {
    added = false;
    for (const id of [...needed]) {
      for (const input of byId.get(id)?.derivedFrom ?? []) {
        if (!needed.has(input)) {
          needed.add(input);
          added = true;
        }
      }
    }
  }
  return [...needed].sort();
}
