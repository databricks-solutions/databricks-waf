// Reading a named set of signals off the estate, once, under a budget.
//
// This was the second half of `runScan` and moved here whole when the advisor got its own run kind
// (ADR 0069). Nothing in it changed in the move, and nothing in it is about an assessment: it takes a
// set of signal ids and returns what reading them produced. What made it look like scan code was where
// the set came from — the registry, the preconditions, the analyzer's own signals — and that part
// stayed behind in `scan.ts`, which is the only thing that knows what a control needs.
//
// The advisory run asks for its set directly, because it has no controls to derive one from. That is
// the whole difference between the two callers, and it is the reason this is a parameter rather than
// something computed here.
//
// # What the loop is careful about, all of which is load-bearing
//
//   * **Sequential across collectors.** Parallelism between them would put two surfaces' worth of work
//     in flight at once, and the per-surface limits in the scheduler would stop bounding total load.
//     Within a collector, the scheduler decides.
//   * **Cancel between units, never inside one.** A stop obeyed mid-collector abandons a unit half
//     read. Checked before the collector rather than after, so a run cancelled before its first unit
//     does no work at all.
//   * **A collector that throws does not fail the run.** It has broken its own contract — it is meant
//     to return unmeasurable readings rather than raise — and letting one collector's bug deny every
//     other pillar is a worse outcome than recording its signals as unmeasured with the fault named.
//   * **A refused checkpoint write is swallowed; a refused end-of-unit checkpoint is not.** See the
//     comment at the `catch` inside `settled`, which is the subtlest thing here and was a live bug.

import { attributed, locate, type Provenance } from './provenance.js';
import type { Collector, CollectorContext, SignalId, SignalResult } from './signal.js';
import type { CredentialProvider, DatabricksCredentials } from './credentials.js';
import type { CollectionScheduler } from '../scan/scheduler.js';

/**
 * What reading the estate needs, whatever the reading is for.
 *
 * The shared half of a scan's options and an advisory run's. Deliberately not `RunScanOptions` minus
 * fields: a shape defined by what it lacks is one that grows a field the moment somebody adds one to
 * the other, and this is the contract two run kinds rest on.
 */
export interface CollectionOptions {
  readonly collectors: readonly Collector[];
  readonly credentials: CredentialProvider;
  readonly lookbackDays: number;
  /** The warehouse the SQL surfaces run on, recorded on each reading it produces. */
  readonly warehouse?: string;
  /** Readings an earlier attempt already reached, so this one does not read them again. */
  readonly resume?: ReadonlyMap<SignalId, SignalResult>;
  /** Called after each collection unit, and after each signal that reports one. */
  readonly checkpoint?: (readings: readonly SignalResult[]) => Promise<void>;
  /** Asked between collection units whether a stop has been recorded. */
  readonly stopping?: () => Promise<boolean>;
}

/**
 * Reads the signals in `needed`, and answers what reading them produced.
 *
 * Every signal asked for is in the answer, or was already in `resume`. A signal nothing collects is
 * simply absent, which is the caller's problem to notice: this cannot tell an unregistered id from one
 * whose collector was not in the list.
 */
export async function collectSignals(
  needed: ReadonlySet<SignalId>,
  options: CollectionOptions,
  scheduler: CollectionScheduler,
  identity: DatabricksCredentials
): Promise<Map<SignalId, SignalResult>> {
  // Seeded with what an earlier attempt reached, so this one does not read it again. Filtered to what
  // this run needs, because a resumed run can have been asked for a narrower set than the attempt that
  // was killed — carrying the extra readings would put signals in the collection that nothing asked
  // for and that the footprint has no record of.
  const collected = new Map<SignalId, SignalResult>();
  for (const [id, reading] of options.resume ?? []) {
    if (needed.has(id)) collected.set(id, reading);
  }

  for (const collector of options.collectors) {
    const mine = collector.signals.filter((signal) => needed.has(signal));
    if (mine.length === 0) continue;

    // Already read, by an earlier attempt at this run. Skipped rather than re-read, which is the point
    // of a checkpoint: without this the resumed attempt is a fresh run that happens to start with a
    // populated map, and nothing has been saved.
    if (mine.every((signal) => collected.has(signal))) continue;

    // Between units rather than inside one, so a cancel is obeyed at a boundary where what has been
    // read is whole. Checked before the collector rather than after, so a run cancelled before its
    // first unit does no work at all.
    if (options.stopping != null && (await options.stopping())) {
      scheduler.cancel();
      break;
    }

    // Stamped here rather than in each collector, so a collector cannot produce an unattributed
    // reading by forgetting to, and so the identity on a reading is the one the run actually used
    // rather than one the collector was told about. A collector that read under a different
    // authority keeps its own; see collect/provenance.
    const from = locate(collector.surface, {
      ...(options.warehouse != null ? { warehouse: options.warehouse } : {}),
      host: identity.host,
    });
    const origin: Provenance = {
      surface: collector.surface,
      collector: collector.name,
      authority: identity.mode,
      actor: identity.actor,
      ...(from != null ? { from } : {}),
    };

    // Two sets rather than one, because a reported reading and a durable one are not the same thing
    // and the difference is what a refused write turns on.
    //
    // `reported` is every reading the collector handed to `settled`, and it is what the loop below
    // skips: those readings are already in `reached`, so taking them again from the returned array
    // would put them in the unit's checkpoint twice.
    //
    // `written` is the subset whose write actually landed, and it is what the checkpoint at the end of
    // the unit leaves out. A reading reported but not written therefore stays in `rest` and is carried
    // by that checkpoint — which is the old grain, and the right thing to fall back to.
    const reported = new Set<SignalId>();
    const written = new Set<SignalId>();

    const reached: SignalResult[] = [];
    const context: CollectorContext = {
      credentials: options.credentials,
      scheduler,
      collected,
      // Offered only when there is somewhere to write. A collector that reads its signals one at a
      // time can then have each of them survive a kill, instead of the whole unit being lost — which
      // for the SQL collector is the difference between losing one statement and losing eleven.
      //
      // Recorded into `collected` as well as written, because the next signal this same collector reads
      // may be one that builds on it, and a reading durable but absent from the collection would be a
      // reading the resumed attempt has and this attempt does not.
      ...(options.checkpoint == null
        ? {}
        : {
            settled: async (result: SignalResult) => {
              const reading = attributed(result, origin);
              collected.set(reading.id, reading);
              reached.push(reading);
              reported.add(reading.id);
              try {
                await options.checkpoint?.([reading]);
                // Only once the write returned. Marking it before the await would mean a failed write
                // removed the reading from the checkpoint at the end of the unit as well, so the one
                // path that was supposed to make a reading more durable would be the one that lost it.
                written.add(reading.id);
              } catch {
                // Deliberately swallowed, and this is the one `catch` here worth arguing about.
                //
                // This call runs inside `collector.collect`, so an exception leaving it arrives at the
                // catch below, which reads any throw as the collector breaking its contract and marks
                // every signal it had not yet read as unmeasurable — with the store's error message as
                // the reason. Those readings are then checkpointed and skipped on resume, so a
                // momentary hiccup in the store would permanently report statements that were never
                // executed as unreadable, and the run would finish and save that. A database blip
                // would arrive at a customer as an estate it cannot see.
                //
                // Losing the write is the smaller failure by a wide margin, because it is not a loss.
                // The reading stays in `collected` and in `reached`, and, not being in `written`, it
                // is carried by the checkpoint at the end of the unit — which is exactly where it
                // would have been written before any of this existed. So a failure here degrades the
                // grain of resumption for this unit back to one collector, and changes nothing else.
                //
                // Nothing is said about it, because in the case that matters there is nothing to say:
                // the reading is on the record a few seconds later by the other path. A store broken
                // for long enough to matter fails the checkpoint at the end of the unit, which is not
                // caught.
              }
            },
          }),
    };

    try {
      for (const result of await collector.collect(mine, context)) {
        // Reported already, so it is in `reached` and taking it again would checkpoint it twice.
        // `reported` rather than `written` deliberately: a reading whose write was refused is still in
        // `reached` once, and the end-of-unit checkpoint is what carries it.
        if (reported.has(result.id)) continue;
        const reading = attributed(result, origin);
        collected.set(result.id, reading);
        reached.push(reading);
      }
    } catch (cause) {
      // A collector that throws has broken its own contract — it is supposed to return
      // unmeasurable results rather than fail. Treating that as a run failure would
      // let one collector's bug deny every other pillar, so its signals are marked
      // unmeasured with the fault named and the run carries on.
      const detail = cause instanceof Error ? cause.message : String(cause);
      for (const signal of mine) {
        if (collected.has(signal)) continue;
        const reading: SignalResult = {
          id: signal,
          status: 'unmeasurable',
          coverage: { mode: 'complete' },
          unmeasurableReason: `The ${collector.name} collector failed: ${detail}`,
          collectedAt: new Date(),
          durationMs: 0,
          // Attributed like any other reading. A failure is still a statement about a surface read
          // as somebody, and a reader deciding whether to re-run it as themselves needs to know
          // which identity it failed for.
          provenance: origin,
        };
        collected.set(signal, reading);
        reached.push(reading);
      }
    }

    // Checkpointed on both paths, because a collector that broke its contract is a unit that finished:
    // its signals are settled as unmeasurable with the fault named, and a retry that re-ran it would
    // re-run a collector already known to fail, for the same answer and another minute of load.
    //
    // What the collector already reported is left out. That is the whole of what a progressive
    // collector changes here: the unit still ends with a checkpoint, and it carries the readings that
    // did not get one on the way past — which for a collector that reports everything is none, and for
    // one that throws part-way is the unmeasurable results the failure produced.
    //
    // Awaited, and a failure here is not caught. Somewhere to write the checkpoint is the premise the
    // whole mechanism rests on, and a run that quietly stopped saving its progress would present as a
    // resumption that starts from nothing — the failure this exists to prevent, arrived at silently.
    const rest = reached.filter((reading) => !written.has(reading.id));
    if (options.checkpoint != null && rest.length > 0) await options.checkpoint(rest);
  }

  return collected;
}

/**
 * Every signal the collectors in this list need in order to produce the ones asked for.
 *
 * Looped until it settles rather than resolved in one sweep, because an input can itself be produced
 * by a collector with inputs. One pass would satisfy the case in front of us today and quietly fail
 * the first two-step chain anyone adds.
 */
export function withInputs(needed: Set<SignalId>, collectors: readonly Collector[]): Set<SignalId> {
  for (let added = true; added; ) {
    added = false;
    for (const collector of collectors) {
      if (!collector.signals.some((signal) => needed.has(signal))) continue;
      for (const input of collector.requires ?? []) {
        if (!needed.has(input)) {
          needed.add(input);
          added = true;
        }
      }
    }
  }
  return needed;
}
