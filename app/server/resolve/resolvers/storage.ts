// Storage resolvers, for the extension controls this project added.
//
// The design assumption these were written against turned out to be wrong in a
// useful direction. `system.storage.table_metrics_history` carries `active_bytes`,
// `active_files` and `predictive_optimization_enabled` per table for the whole
// metastore, so table size and predictive-optimization coverage are complete
// measurements rather than samples — the bounded per-table pass is only needed for
// what that table does not carry.
//
// It can also be present and empty. It was empty on the workspace this was developed
// against, so "no snapshot yet" and "no tables" have to be told apart: reporting an estate
// of zero bytes because a preview table has not populated would be a fabrication, not a
// measurement. That rule now lives on the signal definition rather than here — the
// collector reports the signal unmeasurable when the snapshot is empty, so no resolver
// reading it can forget.
//
// The cost of that rule turned out to be higher than expected, and paying it properly is
// why predictive optimization no longer comes from here. An unmeasurable signal makes
// every control requiring it unmeasurable, and coverage was read as an applicability
// precondition, so one empty platform table silently removed the coverage control and the
// VACUUM control behind it. Coverage is now read per catalog with `DESCRIBE CATALOG
// EXTENDED`, which answers.
//
// Storage volume had the same disease and needed a different cure, because the numbers it
// wants — bytes and files — were already being collected by the tier-2 per-table pass while
// this control reported no measurement at all. It now reads whichever source answered,
// preferring the complete one, and states which. `storage-reading.ts` holds that choice.

import type { ControlResolver } from '../resolver.js';
import type { MaintenanceRecency, PredictiveOptimizationCoverage } from '../../collect/sql/shapes.js';
import {
  bandsOf,
  bytes,
  detailFrom,
  enrichedBy,
  evidenceFrom,
  fromSignals,
  observedValue,
  sourcedFrom,
  threshold,
  unmeasured,
  valueOf,
} from './helpers.js';
import { VOLUME_SIGNAL, type CloudVolume } from '../../collect/cloud/collector.js';
import {
  averageBelowTarget,
  compactedShare,
  describeTotal,
  ESTATE_AVERAGE_CAVEAT,
  fragmentationEvidence,
  readFragmentation,
  readStorage,
  storageUnreadable,
  STORAGE_SIGNALS,
} from './storage-reading.js';

const MAINTENANCE = 'sql:maintenance.recency';
const PO = 'describe:predictive_optimization.coverage';

/**
 * CO-03-05: storage volume, growth and file counts.
 *
 * The extension exists because the cost pillar treats compute spend in detail and
 * stored bytes not at all, yet storage is a standing charge that grows without
 * anyone deciding to grow it.
 *
 * Small-file pressure is reported alongside the total because bytes alone hide it: a
 * terabyte in ten thousand files and a terabyte in fifty behave nothing alike.
 */
const storageVolume = enrichedBy(
  [VOLUME_SIGNAL],
  sourcedFrom(
    STORAGE_SIGNALS,
    fromSignals([], ['CO-03-05'], (context) => {
    const reading = readStorage(context);
    if (reading == null) return unmeasured(storageUnreadable(context));

    const minAverage = threshold(context.spec, 'min_average_file_bytes', 16 * 1024 * 1024);
    const fragmentation = readFragmentation(context, minAverage);

    const bill = observedValue<CloudVolume>(context, VOLUME_SIGNAL);
    const billed =
      bill == null
        ? []
        : [
            detailFrom(
              context,
              VOLUME_SIGNAL,
              `${bytes(bill.billedBytes)} billed across ${
                bill.locations === 1 ? '1 external location' : `${String(bill.locations)} external locations`
              }`
            ),
          ];

    // The volume itself is the control; small-file pressure is reported alongside it,
    // because bytes alone hide it — a terabyte in ten thousand files and a terabyte in
    // fifty behave nothing alike. It only reduces the outcome where it is a real finding,
    // never where the tables are simply too small for it to mean anything.
    const evidence = [
      evidenceFrom(
        context,
        reading.signal,
        `${describeTotal(reading)}. ${reading.basis}`,
        'Storage volume is measured and tracked, so growth is visible before it becomes a surprise'
      ),
      ...billed,
      ...(fragmentation != null ? [fragmentationEvidence(context, fragmentation, minAverage)] : []),
      ...(reading.largest.length > 0
        ? [
            detailFrom(
              context,
              reading.signal,
              `Largest: ${reading.largest.map((table) => `${table.name} at ${bytes(table.sizeBytes)}`).join('; ')}`
            ),
          ]
        : []),
    ];

    // Never worse than partial from fragmentation: the control is that volume is measured,
    // and it was. Small files are a note on a measured estate, not a failure to measure it.
    const compacted = compactedShare(fragmentation);
    const bands = bandsOf(context.spec, { pass: 0.9, partial: 0.6 });
    const fragmented =
      averageBelowTarget(fragmentation, minAverage) || (compacted != null && compacted < bands.pass);

    if (fragmented) {
      return {
        outcome: 'partial',
        evidence,
        outcomeReason:
          'The volume is measurable, but files are smaller than the size at which per-file overhead stops ' +
          'dominating scans. That costs read performance and metadata overhead rather than storage ' +
          'directly, and is what OPTIMIZE or predictive optimization addresses.' +
          (fragmentation?.kind === 'estate-average' ? ` ${ESTATE_AVERAGE_CAVEAT}` : ''),
      };
    }

    return {
      outcome: 'pass',
      evidence,
      // A pass from a sample is the weaker of the two sampled claims and has to say so:
      // nothing measured was fragmented, which is not the same as nothing being
      // fragmented. The failing direction needs no such hedge.
      ...(reading.complete
        ? {}
        : {
            outcomeReason:
              `Measured across ${reading.tables.toLocaleString('en-US')} tables rather than the whole ` +
              'metastore, so this says the tables read are well sized rather than that every table is. ' +
              'A complete reading needs the platform\u2019s per-table storage snapshot, which has no rows ' +
              'for this metastore.',
          }),
    };
  })
  )
);

/**
 * CO-03-06: VACUUM.
 *
 * Absence of manual VACUUM is only a finding where predictive optimization is not
 * doing it. Where it is, the absence is correct behaviour — the same error class as
 * marking down a serverless estate for having no cluster policies, and the reason
 * this resolver reads the coverage signal before the recency one.
 *
 * The evidence for manual maintenance is also weaker than it looks, and the finding
 * says so: query history records SQL warehouse and serverless activity but not
 * commands run in notebooks on classic compute, so a nightly VACUUM from a job
 * cluster is invisible here.
 */
const vacuum = fromSignals([MAINTENANCE, PO], ['CO-03-06'], (context) => {
  const maintenance = valueOf<MaintenanceRecency>(context, MAINTENANCE);
  const po = valueOf<PredictiveOptimizationCoverage>(context, PO);
  const maxDays = threshold(context.spec, 'max_days_since_vacuum', 30);

  const automatic = maintenance.operations.find(
    (op) => op.source === 'predictive_optimization' && op.operation.toUpperCase().includes('VACUUM')
  );
  const manual = maintenance.operations.find((op) => op.source === 'manual' && op.operation.toUpperCase() === 'VACUUM');
  const unresolved = maintenance.operations.find(
    (op) => op.source === 'manual_unresolved' && op.operation.toUpperCase() === 'VACUUM'
  );

  // Enablement decides this, not observed runs. Requiring a VACUUM in the window as well
  // looks stricter and is wrong: predictive optimization runs when files become eligible,
  // so a quiet window on a small or append-only estate means nothing needed reclaiming.
  // Demanding a run would mark down exactly the estates that delegated the work correctly
  // and then gave it nothing to do — the same error as failing a serverless estate for
  // having no cluster policies. A run, where there is one, is confirmation and not the test.
  if (po.state === 'enabled') {
    return {
      outcome: 'satisfied-by-architecture',
      evidence: [
        evidenceFrom(
          context,
          PO,
          `Predictive optimization covers all ${po.managedTables} managed tables by their catalog setting`,
          'Stale files are reclaimed without a scheduled manual command'
        ),
        evidenceFrom(
          context,
          MAINTENANCE,
          automatic != null
            ? `It ran VACUUM ${automatic.operations} times, most recently ${describeWhen(automatic.lastRun)}`
            : 'No VACUUM run by predictive optimization appears in the window',
          'Stale files are reclaimed within the expected interval'
        ),
      ],
      outcomeReason:
        `Every catalog holding managed tables has predictive optimization enabled, covering all ` +
        `${po.managedTables} of them, so the absence of manual VACUUM is correct behaviour rather than a ` +
        'gap. ' +
        (automatic != null
          ? 'It has run VACUUM within the window.'
          : 'No run appears in the window, which is expected where no files became eligible — predictive ' +
            'optimization acts when there is something to reclaim rather than on a schedule.') +
        ' Enablement is read per catalog, so a schema or table that overrides its catalog would not ' +
        'appear here.',
    };
  }

  const observed = [
    automatic != null ? `predictive optimization ran VACUUM ${describeWhen(automatic.lastRun)}` : undefined,
    manual != null ? `${manual.operations} manual VACUUM statements, last ${describeWhen(manual.lastRun)}` : undefined,
  ].filter((part): part is string => part != null);

  if (observed.length === 0) {
    // Manual VACUUM statements that could not be joined to an assessed table are not
    // evidence the estate was maintained, and they are also not evidence that nothing ran —
    // the target was unreadable. Unknown rather than credit or fail.
    if (unresolved != null) {
      return {
        outcome: 'unmeasurable',
        evidence: [
          evidenceFrom(
            context,
            MAINTENANCE,
            `${unresolved.operations} manual VACUUM statement${unresolved.operations === 1 ? '' : 's'} in the window ` +
              'could not be attributed to a table in the assessed population',
            `VACUUM runs at least every ${maxDays} days on tables outside predictive optimization`
          ),
          evidenceFrom(
            context,
            PO,
            po.state === 'unknown'
              ? 'No catalog reported a predictive optimization setting'
              : `Predictive optimization covers ${po.enabledTables} of ${po.managedTables} managed tables ` +
                'by their catalog setting',
            'Tables are either covered by predictive optimization or maintained manually'
          ),
        ],
        outcomeReason:
          'Query history shows VACUUM commands whose target table could not be resolved into the assessed ' +
          'metastore — leading comments are stripped, but a quoted identifier, a two-part name, or a name ' +
          'outside the assessed catalogs still leaves the command unattributed. Crediting those would ' +
          'pass an estate for work done elsewhere; failing them would invent a gap. Reported unmeasured.',
      };
    }

    return {
      // Partial coverage earns partial credit rather than a failure, because part of the
      // estate is being maintained by the platform and only the remainder is exposed.
      outcome: po.state === 'unknown' ? 'unmeasurable' : po.state === 'partial' ? 'partial' : 'fail',
      evidence: [
        evidenceFrom(
          context,
          MAINTENANCE,
          'No VACUUM was observed in the window, from predictive optimization or manually',
          `VACUUM runs at least every ${maxDays} days on tables outside predictive optimization`
        ),
        evidenceFrom(
          context,
          PO,
          po.state === 'unknown'
            ? 'No catalog reported a predictive optimization setting'
            : `Predictive optimization covers ${po.enabledTables} of ${po.managedTables} managed tables ` +
              'by their catalog setting',
          'Tables are either covered by predictive optimization or maintained manually'
        ),
      ],
      outcomeReason:
        po.state === 'unknown'
          ? 'No catalog reported a predictive optimization setting, so whether VACUUM should be running ' +
            'manually cannot be determined — where predictive optimization is on it does this ' +
            'automatically, and where it is off the absence above is a gap.'
          : `${po.managedTables - po.enabledTables} managed tables are not covered by predictive ` +
            'optimization and no VACUUM was seen for them. Query history does not record commands run in ' +
            'notebooks on classic compute, so scheduled maintenance from a job cluster would not appear ' +
            'here — check before treating this as a gap.',
    };
  }

  const last = latest(automatic?.lastRun, manual?.lastRun);
  const days = last == null ? undefined : Math.floor((Date.now() - last.getTime()) / 86_400_000);
  const withinWindow = days != null && days <= maxDays;

  return {
    outcome: withinWindow ? 'pass' : 'partial',
    evidence: [
      evidenceFrom(
        context,
        MAINTENANCE,
        observed.join('; '),
        `VACUUM runs at least every ${maxDays} days on tables outside predictive optimization`
      ),
      evidenceFrom(
        context,
        PO,
        po.state === 'unknown'
          ? 'No catalog reported a predictive optimization setting'
          : `Predictive optimization is ${po.state}, covering ${po.enabledTables} of ${po.managedTables} ` +
            'managed tables by their catalog setting',
        'Tables are either covered by predictive optimization or maintained manually'
      ),
    ],
    ...(withinWindow
      ? {}
      : {
          outcomeReason: `The most recent VACUUM was ${String(days ?? 'an unknown number of')} days ago, beyond the ${maxDays}-day expectation.`,
        }),
  };
});

export const STORAGE_RESOLVERS: readonly ControlResolver[] = [storageVolume, vacuum];

function describeWhen(when: Date | undefined): string {
  if (when == null) return 'at an unrecorded time';
  const days = Math.floor((Date.now() - when.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function latest(...dates: readonly (Date | undefined)[]): Date | undefined {
  const known = dates.filter((d): d is Date => d != null);
  if (known.length === 0) return undefined;
  return known.reduce((newest, d) => (d > newest ? d : newest));
}
