// DG-03-02: what the quality monitor last wrote, reported and not scored.
//
// The constraint half of the requirement is settled by 37f (`delta.constraints.*`). This is the
// monitoring clause. `78` measured the table and ruled out both bands a resolver might have taken:
// estate coverage is platform adoption (2.8% on large-estate), and the health share of monitored
// tables is 98.6% Healthy with one Unhealthy — it moves for nobody. Labs has no such schema, so
// there is nowhere to calibrate a threshold. ADR 0102 records the decision: attach the counts,
// do not band, hand the on-failure question to a person.
//
// Grain is the statement's: latest verdict per table, not a count of results. Healthy is not a
// pass. Zero monitored tables is not a fail. An absent schema never reaches this file —
// `fromSignal` reports it unread.

import type { ControlResolver, Resolution } from '../resolver.js';
import type { QualityMonitoring } from '../../collect/sql/shapes.js';
import { share } from '../../collect/sql/rows.js';
import {
  agreeing,
  detailFrom,
  evidenceFrom,
  fromSignal,
  notApplicable,
  percent,
} from './helpers.js';

const MONITOR = 'sql:uc.quality_monitoring';

/**
 * DG-03-02: report the monitor, do not score it.
 *
 * Two outcomes that settle nothing about the requirement. An empty metastore has no tables to
 * monitor. Anything else is unmeasured (`attestation`) with the counts beside the question —
 * including an estate the monitor covers completely and one it does not cover at all.
 */
const qualityMonitoring = fromSignal<QualityMonitoring>(
  MONITOR,
  ['DG-03-02'],
  (reading, context): Resolution => {
    if (reading.estateTables === 0) {
      return notApplicable(
        'This metastore contains no customer tables, so there is nothing for the quality monitor to cover.'
      );
    }

    const covered = share(reading.monitoredTables, reading.estateTables);
    const { noun: estateNoun } = agreeing(reading.estateTables, 'customer table');
    const { noun: monitoredNoun, verb: monitoredVerb } = agreeing(reading.monitoredTables, 'table');
    const coverage =
      covered == null
        ? `${monitoredNoun} monitored`
        : `${reading.monitoredTables.toLocaleString('en-US')} of the ${estateNoun} ${monitoredVerb} ` +
          `a latest quality-monitor verdict in the window (${percent(covered)})`;

    const verdicts =
      `${reading.healthy.toLocaleString('en-US')} Healthy, ` +
      `${reading.unhealthy.toLocaleString('en-US')} Unhealthy, ` +
      `${reading.training.toLocaleString('en-US')} Training, ` +
      `${reading.errored.toLocaleString('en-US')} Error` +
      (reading.unnamedStatus > 0
        ? `, ${reading.unnamedStatus.toLocaleString('en-US')} with a status this reading does not name`
        : '');

    return {
      outcome: 'unmeasurable',
      unmeasured: 'attestation',
      evidence: [
        evidenceFrom(
          context,
          MONITOR,
          `${coverage}, across ${reading.monitoredCatalogs.toLocaleString('en-US')} of ` +
            `${reading.estateCatalogs.toLocaleString('en-US')} customer catalogs`,
          'The count and coverage of tables the quality monitor last wrote a verdict for'
        ),
        detailFrom(
          context,
          MONITOR,
          `Of those monitored tables, the latest verdict was ${verdicts}`
        ),
      ],
      outcomeReason:
        `${coverage}. Of those, the latest verdict was ${verdicts}. ` +
        'That reading does not settle the requirement: a table the monitor watches is not a pipeline ' +
        'that stops or quarantines a bad row, and what happens on failure (`expect`, `expect_or_drop`, ' +
        '`expect_or_fail`) lives in pipeline code this scan does not read. The counts are reported ' +
        'rather than scored — estate coverage measures whether the monitor was turned on, and a ' +
        'Healthy share of the tables it already watches is what the monitor is for.',
    };
  }
);

export const QUALITY_MONITORING_RESOLVERS: readonly ControlResolver[] = [qualityMonitoring];
