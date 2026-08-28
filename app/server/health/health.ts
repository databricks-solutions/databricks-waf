// Whether the things this app depends on are answering, and what to do about the ones that are not.
//
// The gap this closes is not "there is no status page". It is that an install which is half-bound
// reports its symptoms one page at a time and never names the cause: a pillar mostly unmeasured on
// the overview, a history that will not load under History, an answer that warns it will be lost on
// the next deploy, a scan that refuses to compare against the last one. Each of those pages says
// something true and none of them says *which single binding* is behind all of them, so the person
// who has to fix it reads four complaints and guesses.
//
// So this is one reading per dependency, in one place, each with what it means and what an operator
// should do. Four dependencies, because four things can be bound wrongly: the SQL warehouse the
// statements run on, the Lakebase database the records are kept in, the identity endpoint the gate
// asks about group membership, and the audit log — which is the same database and is listed
// separately because it can be failing while the rest of it works, and a trail with holes in it is
// the one failure the app has to volunteer rather than wait to be asked about.
//
// # Nothing here spends the customer's money
//
// This is the constraint that shapes the whole module, and it is the reason a reading can be
// `observed` rather than `probed`.
//
// A health check that ran a statement to see whether the warehouse answers would wake a serverless
// warehouse that had gone to sleep, and bill the customer for it. On an ungated endpoint — which
// this is, like every other read here — that makes a page refresh a way to spend somebody else's
// money, and a loop a way to spend rather a lot of it. There is a route that deliberately does spend
// it, `POST /api/definitions/:id/preflight`, and it is gated as a mutation for exactly this reason.
//
// So the warehouse reading is *observed*: it says what the last thing to use the warehouse found,
// and when. That is weaker than a live probe and it is honest about being weaker. It is also, on the
// question an operator is actually asking — "is my warehouse binding right" — very nearly as good,
// because the last scan is the only evidence that matters and a fresh probe of a working warehouse
// tells them nothing they did not already know.
//
// The database is probed, because `select 1` on a pooled connection costs nothing and wakes nothing.
// The identity endpoint is probed only when the request carries a token, because that is the only
// authority this app has to ask with and a reading taken on the app's own identity would answer a
// question nobody asked.

// The only import in this module, and a type. Every reading here is composed from values handed in,
// which is what lets the whole surface be tested without a database — and the posture is a word the
// recorder owns, so naming it here rather than importing it would be a second copy of a vocabulary
// that could disagree with the thing enforcing it.
import type { AuditPosture } from '../audit/record.js';

/** How a dependency is doing, in the four states an operator does different things about. */
export type Standing =
  /** Reached, and it answered. */
  | 'answering'
  /** Reached, and it is not doing all of its job. A trail with unwritten events; a warehouse that answered some statements and refused others. */
  | 'degraded'
  /** Reached for, and it did not answer. Bound, and broken or unreachable. */
  | 'silent'
  /** Not bound at all. The commonest of the four in a fresh install, and the only one with a form to fill in. */
  | 'unbound'
  /** Nothing here knows. Distinct from `answering` on purpose — see `readingsFor`. */
  | 'unknown';

/**
 * Where a reading came from, which is what stops it overclaiming.
 *
 * `probed` was established now. `observed` is what the last thing to use the dependency found, and
 * carries `at` so a reader can see how old it is. A reading with no provenance would let "the
 * warehouse is answering" mean either "I just asked it" or "it worked last Tuesday", and the second
 * is not something to reassure somebody with.
 */
export type Provenance = 'probed' | 'observed';

export type Dependency = 'warehouse' | 'database' | 'identity' | 'audit-log';

export interface Reading {
  readonly dependency: Dependency;
  readonly standing: Standing;
  readonly provenance: Provenance;
  /** When the reading was taken. For an observed one, when the observation was made rather than now. */
  readonly at: Date;
  /** What this means, for somebody who did not write the app. */
  readonly detail: string;
  /**
   * What to do about it, where there is something to do.
   *
   * Absent on `answering`, because an instruction beside a working dependency is an instruction
   * somebody eventually follows.
   */
  readonly action?: string;
}

export interface Health {
  readonly at: Date;
  readonly readings: readonly Reading[];
  /**
   * Whether anything is wrong, so a caller does not have to reduce the list itself.
   *
   * Two consumers would otherwise each write their own reduction and one of them would disagree with
   * the page beside it about whether the install is healthy.
   */
  readonly well: boolean;
  /** How many acts this process could not write down. Zero on a healthy install. */
  readonly unrecorded: number;
}

/**
 * What health can be read from, injected rather than reached for.
 *
 * Every member is optional, and each absence is a real install rather than a missing test double: an
 * app with no recorder configured, a demo install with no database, a request that arrived without a
 * forwarded token. An absent probe reads `unknown`, which is the honest answer and is deliberately
 * not `unbound` — "I cannot tell" and "there is nothing there" send an operator to different places.
 */
export interface HealthSources {
  /** Answers, or throws. A `select 1`: cheap, and wakes nothing. */
  readonly pingDatabase?: () => Promise<void>;
  /** Where records are kept, in the words the rest of the app uses. Absent when nothing is bound. */
  readonly storage?: string;
  /** Whether the store that answers questions survives a restart. */
  readonly durable?: boolean;
  /** Answers with who the caller is, or throws. Only present when the request carried a token. */
  readonly probeIdentity?: () => Promise<void>;
  /** The warehouse id this install is bound to, absent when none is. */
  readonly warehouseId?: string | undefined;
  /** What the last run's statements did, for the observed warehouse reading. */
  readonly lastRun?: {
    readonly at: Date;
    readonly statements: number;
    readonly refused: number;
  };
  /** How many events the recorder could not write. Absent when this install records no acts. */
  readonly unrecorded?: number;
  /**
   * What this install does about an act it cannot record.
   *
   * Read off the recorder rather than from the environment here, so this cannot report a posture the
   * thing enforcing it is not in. Absent for an install with no recorder, where the question does
   * not arise.
   */
  readonly auditPosture?: AuditPosture;
  /** Whether the audit log survives a restart, so a trail held in memory is not reported as a trail. */
  readonly auditDurable?: boolean;
  readonly now?: () => Date;
}

/**
 * Reads every dependency once.
 *
 * The probes run together rather than in sequence: they are independent, and a database that takes
 * three seconds to time out should not make the identity reading three seconds older than it needed
 * to be. Neither probe is allowed to reject — each is caught into its own reading — because a health
 * endpoint that fails is the least useful thing this could be.
 */
export async function readHealth(sources: HealthSources = {}): Promise<Health> {
  const now = (sources.now ?? (() => new Date()))();
  const [database, identity] = await Promise.all([databaseReading(sources, now), identityReading(sources, now)]);
  const readings: readonly Reading[] = [warehouseReading(sources, now), database, identity, auditReading(sources, now)];

  return {
    at: now,
    readings,
    // `unknown` does not make an install unwell. A reading nothing could take is not evidence of a
    // fault, and treating it as one would report every demo install as broken and teach the reader
    // to ignore the flag on the installs where it means something.
    well: !readings.some((reading) => reading.standing === 'degraded' || reading.standing === 'silent'),
    unrecorded: sources.unrecorded ?? 0,
  };
}

/**
 * What the warehouse was last seen doing.
 *
 * Three cases, and the middle one is why this is worth a function. No binding is `unbound` and has a
 * form to fill in. A binding no scan has used yet is `unknown` rather than `answering`, because the
 * commonest way for this to be wrong is a warehouse id that names a warehouse the app cannot reach,
 * and reporting that as healthy until somebody runs a scan would be the reading that matters being
 * wrong for exactly as long as it mattered. A binding whose last run had statements refused is
 * `degraded` — the warehouse answered, and the app could not read what it needed.
 */
function warehouseReading(sources: HealthSources, now: Date): Reading {
  if (sources.warehouseId == null || sources.warehouseId === '') {
    return {
      dependency: 'warehouse',
      standing: 'unbound',
      provenance: 'probed',
      at: now,
      detail: 'No SQL warehouse is bound, so nothing this app measures from the system tables can run.',
      action:
        'Open the app in your workspace, choose Edit, and add a SQL warehouse resource. Everything the ' +
        'assessment reads comes from system tables through it.',
    };
  }

  const run = sources.lastRun;
  if (run == null) {
    return {
      dependency: 'warehouse',
      standing: 'unknown',
      provenance: 'observed',
      at: now,
      detail:
        `A warehouse is bound (${sources.warehouseId}) and nothing has used it yet, so whether this app can ` +
        'reach it is not established. Nothing here probes it, because waking a serverless warehouse to ' +
        'answer a status page would bill you for the answer.',
      action: 'Run an assessment. It will say which statements the warehouse answered and which it refused.',
    };
  }

  if (run.refused > 0) {
    return {
      dependency: 'warehouse',
      standing: 'degraded',
      provenance: 'observed',
      at: run.at,
      detail:
        `The warehouse answered the last run and refused ${String(run.refused)} of ${String(run.statements)} ` +
        'statements, so part of the assessment was measured and part of it was not.',
      action:
        'Open Checks. It lists every statement, the table it reads and the grant it needs, and names the ' +
        'ones that were refused.',
    };
  }

  return {
    dependency: 'warehouse',
    standing: 'answering',
    provenance: 'observed',
    at: run.at,
    detail: `The last run read all ${String(run.statements)} of its statements through the bound warehouse.`,
  };
}

async function databaseReading(sources: HealthSources, now: Date): Promise<Reading> {
  if (sources.pingDatabase == null) {
    // No pool to ping. Either nothing is bound, or this install was started with persistence off —
    // and `storage` is the sentence the rest of the app already uses to tell those apart, so it is
    // repeated here rather than paraphrased into a fifth wording of the same fact.
    return {
      dependency: 'database',
      standing: 'unbound',
      provenance: 'probed',
      at: now,
      detail:
        sources.storage ??
        'No database is bound, so nothing this app records — scan history, answers, decisions — survives a restart.',
      action:
        'Open the app in your workspace, choose Edit, and add a database resource with ' +
        'CAN_CONNECT_AND_CREATE. The app creates its own schema on first boot.',
    };
  }

  try {
    await sources.pingDatabase();
  } catch (cause) {
    return {
      dependency: 'database',
      standing: 'silent',
      provenance: 'probed',
      at: now,
      // The cause is named because this is the one reading whose fault is usually transient and
      // usually specific — a role without CAN_CONNECT_AND_CREATE, an endpoint that has scaled to
      // zero — and an operator who cannot see which cannot tell whether to wait or to act.
      detail: `A database is bound and did not answer: ${describe(cause)}.`,
      action:
        'The records are not lost; they are unreachable. If this persists, check that the database ' +
        'resource is running and that the app service principal still has CAN_CONNECT_AND_CREATE on it.',
    };
  }

  return {
    dependency: 'database',
    standing: sources.durable === false ? 'degraded' : 'answering',
    provenance: 'probed',
    at: now,
    detail:
      sources.durable === false
        ? (sources.storage ?? 'The database answered, and this app is not keeping its records in it.')
        : (sources.storage ?? 'The database answered.'),
    ...(sources.durable === false
      ? {
          action:
            'Nothing this app records will survive the next deploy. Unset WAF_DEMO_NO_PERSISTENCE and ' +
            'restart to keep it.',
        }
      : {}),
  };
}

async function identityReading(sources: HealthSources, now: Date): Promise<Reading> {
  if (sources.probeIdentity == null) {
    return {
      dependency: 'identity',
      standing: 'unknown',
      provenance: 'probed',
      at: now,
      detail:
        'This request carried no forwarded token, so there was nothing to ask the identity endpoint ' +
        'with. Nothing is asked on the app’s own identity, because a membership it holds is not the ' +
        'membership the gate has to check.',
      action: 'Open this page while signed in through the app, and it will report what the gate can establish.',
    };
  }

  try {
    await sources.probeIdentity();
  } catch (cause) {
    return {
      dependency: 'identity',
      standing: 'silent',
      provenance: 'probed',
      at: now,
      detail: `The identity endpoint did not answer: ${describe(cause)}.`,
      // Named as the consequence rather than as an outage, because this is the failure whose effect
      // is least obvious from the symptom: reads keep working, and every attempt to change anything
      // is refused for a reason that sounds like the caller's fault.
      action:
        'While this lasts, nobody can start a scan, answer a requirement or decide a finding — the gate ' +
        'refuses what it cannot establish. Reading the assessment is unaffected.',
    };
  }

  return {
    dependency: 'identity',
    standing: 'answering',
    provenance: 'probed',
    at: now,
    detail: 'The identity endpoint answered, so the gate can establish who a caller is and what they may change.',
  };
}

/**
 * What the trail is missing.
 *
 * Its own reading rather than a number on the database one, because the two fail separately and the
 * operator does different things about them. It is also the only reading here that reports a fault
 * which has already happened and cannot be undone: an event that was not written is gone, and
 * nothing an operator does now recovers it. Which is exactly why it is volunteered.
 */
function auditReading(sources: HealthSources, now: Date): Reading {
  if (sources.unrecorded == null) {
    return {
      dependency: 'audit-log',
      standing: 'unknown',
      provenance: 'probed',
      at: now,
      detail: 'This install records no audit events, so there is no trail to report on.',
    };
  }

  if (sources.unrecorded > 0) {
    const strict = sources.auditPosture === 'strict';
    return {
      dependency: 'audit-log',
      standing: 'degraded',
      provenance: 'probed',
      at: now,
      detail:
        `${String(sources.unrecorded)} ${sources.unrecorded === 1 ? 'action' : 'actions'} could not be written to ` +
        'the trail since this app last started. They happened; the record of them did not. A gap in the ' +
        'trail is not a gap in what was done.' +
        // Worth more than a repeat of the sentence above, because on a strict install this reading is
        // evidence about the setting itself: it is what refusing before the act did not prevent. Both
        // of the ways it can be reached are named, because naming one would be a sentence that reads
        // as a diagnosis and is wrong half the time — an operator told the trail answered first will
        // go looking for a write fault when the trail may have been unreachable throughout.
        (strict
          ? ' This install refuses an action it cannot reach the trail to record, so a count here is what ' +
            'that check could not prevent: a record that failed after the trail had answered, or a ' +
            'refusal the gate had already made before the check could run.'
          : ''),
      // Deliberately not "acts are being refused". The count establishes that appends failed, and
      // nothing more: a trail that reads and will not write refuses nothing, and every act on it is
      // performed and lost exactly as on the default posture. Whether changes are being refused as
      // well is the database reading's to answer, and an action that asserted it here would send an
      // operator looking for refusals that may not be happening.
      action: strict
        ? 'The cause is the database reading above. Refusing before the action does not prevent this, so ' +
          'the count is a real gap: read it as you would on any install. If the trail stops answering ' +
          'altogether, the symptom changes — changes start being refused rather than going unrecorded.'
        : 'The cause is the database reading above. Once it answers, new events are recorded again — the ones ' +
          'already missed cannot be recovered, so what happened during the gap has to come from elsewhere.',
    };
  }

  if (sources.auditDurable === false) {
    return {
      dependency: 'audit-log',
      standing: 'degraded',
      provenance: 'probed',
      at: now,
      detail:
        'Events are being recorded in memory and will be lost when this app restarts, which happens on ' +
        'every deploy. Nothing is missing yet, and everything will be.',
      action: 'Bind a database, or unset WAF_DEMO_NO_PERSISTENCE, so the trail survives a restart.',
    };
  }

  // Which posture, on the reading that is otherwise a zero. A zero meaning "nothing was lost" and a
  // zero meaning "nothing can be lost" are different facts about an install, and an auditor reading
  // this page is reading it for the second one. The amendment to ADR 0046 asks for exactly this.
  return {
    dependency: 'audit-log',
    standing: 'answering',
    provenance: 'probed',
    at: now,
    detail:
      'Every action since this app last started has been written to the trail. ' +
      (sources.auditPosture === 'strict'
        ? 'An action this app cannot record is refused rather than performed, so a change that is not in ' +
          'the trail did not happen — except for a record that fails after the trail has answered, ' +
          'which would show as a count above.'
        : 'An action this app cannot record still stands, and the count above is how many there have been.'),
  };
}

/**
 * A cause, in as few words as carry information.
 *
 * The message rather than the class, which is the opposite of what the audit log does with the same
 * value — and deliberately: this is a diagnostic read by an operator now, not a record kept for
 * years and exported to third parties, and "connection refused" is the whole of what they need. The
 * first line only, because a driver's stack has no business on a page.
 */
function describe(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (message.split('\n')[0] ?? '').trim() || 'no reason given';
}
