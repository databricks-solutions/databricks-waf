// Which surface produced a reading, and whose eyes it was read with.
//
// Every number this app reports is going to be disputed by somebody eventually, and the storage
// numbers first: a customer told their largest table is 4.1 TB and carries eleven months of
// reclaimable history will want to know where that came from before they act on it. The scan stamp
// answers that for the run as a whole — one actor, one execution mode — and that was enough only for
// as long as a run had one identity in it.
//
// It does not. A scan reads the estate as the signed-in user, writes its own history as the app's
// service principal, and the cloud-volume tier reads object storage as whatever Unity Catalog
// service credential the install configured. Those are three authorities inside one run, and a
// per-scan stamp reports the first of them as if it produced all three. So attribution belongs on
// the reading, not on the run.
//
// Four fields, and each earns its place by being something a reader needs to reproduce the number:
// which surface answered, which collector on it, under what authority, and where. Together they turn
// "the app says 4.1 TB" into "DESCRIBE DETAIL on that table, run on warehouse 4b9b95… as
// alice@example.com" — which the customer can run themselves, and which is the only form of
// disagreement worth having.

import type { Surface } from '../scan/surfaces.js';
import type { ExecutionMode } from './credentials.js';
import type { SignalResult } from './signal.js';

/**
 * How a reading was authorised.
 *
 * The two execution modes plus the two that are neither. A Unity Catalog service credential is not
 * an execution mode, because it does not run the scan — it authorises one surface within a scan that
 * is running as somebody else. Folding it into `ExecutionMode` would make every comparison of two
 * scans' modes ambiguous.
 *
 * `admin-cli` is further out still: nothing in this process made the reading. An administrator ran the
 * published script at a terminal, under permissions this app does not hold and cannot verify, and
 * imported the output. It is a distinct authority rather than a flag on an existing one because it is
 * the only one whose reading this app cannot repeat, which is exactly what makes the evidence resting
 * on it `admin-collected` rather than observed. See resolve/evidence-class and ADR 0041.
 */
export type Authority = ExecutionMode | 'service-credential' | 'admin-cli';

export interface Provenance {
  readonly surface: Surface;
  /** Which collector produced it. One surface carries more than one, and they read different things. */
  readonly collector: string;
  readonly authority: Authority;
  /**
   * The identity the reading was made as: a username, a service principal application id, or the
   * name of the service credential.
   *
   * Recorded per reading because it is the answer to the question a disputed finding provokes —
   * whether the app was looking at the estate with the reader's own permissions or with more.
   */
  readonly actor: string;
  /**
   * Where the reading was made, named the way a reader would name it to make it again: a warehouse
   * id for the SQL surfaces, the workspace host for REST, a bucket or container for cloud storage.
   *
   * Absent when nothing said, which is the case in tests and for any collector that has not been
   * told. Absent is honest; a plausible default would be worse than nothing here, because the whole
   * value of the field is that it can be checked.
   */
  readonly from?: string;
}

/**
 * Where each surface reads, given what the install bound.
 *
 * Passed as one object rather than resolved per collector because the two facts come from different
 * places — the warehouse from the app's resource binding, the host from the credentials — and
 * neither is known to a collector, which receives an injected executor and cannot tell a warehouse
 * from a fixture.
 */
export interface Locations {
  /** The SQL warehouse the consuming admin bound, if one is bound. */
  readonly warehouse?: string;
  /** The workspace this app is installed in. */
  readonly host?: string;
}

/**
 * The place a surface reads from, or nothing when it was not supplied.
 *
 * `sql` and `describe` both run statements on the bound warehouse; they are separate surfaces
 * because they scale differently against it, not because they run in different places. `cloud` is
 * absent on purpose: the collector that reads it knows its own bucket, and a guess made here would
 * be the one field in this record that could not be checked.
 */
export function locate(surface: Surface, locations: Locations): string | undefined {
  if (surface === 'sql' || surface === 'describe') {
    return locations.warehouse == null ? undefined : `warehouse ${locations.warehouse}`;
  }
  // `plans` reads the query history service on the same host, and unlike `cloud` there is nothing
  // else it could be reading: the endpoint answers only for the workspace the app runs in.
  if (surface === 'rest' || surface === 'plans') return locations.host;
  return undefined;
}

/**
 * A reading with its origin recorded, unless it already recorded its own.
 *
 * The precedence is what makes this extensible without a second mechanism. A collector that knows
 * something the scan cannot — the cloud collector, reading object storage under a service
 * credential rather than under the identity running the scan — sets `provenance` on the result it
 * returns and this leaves it alone. Everything else is stamped centrally, so no collector has to
 * remember, and a collector added later cannot produce unattributed readings by omission.
 */
export function attributed(result: SignalResult, provenance: Provenance): SignalResult {
  return result.provenance != null ? result : { ...result, provenance };
}
