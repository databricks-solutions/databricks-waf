// Security controls answered by system-table signals about jobs and Unity Catalog storage.
//
// SCP-04-22 reads `run_as` from `system.lakeflow.jobs` — the identity jobs execute as —
// and measures what share run as a service principal rather than a user account.
//
// SCP-04-05 reads `storage_path` from `system.information_schema.tables` and counts
// Unity Catalog managed tables stored on DBFS root, which carries no file-level access
// control.
//
// Both signals are read from system tables the app queries as part of its standard
// SQL surface; no new REST scope is required for either.

import type { ControlResolver } from '../resolver.js';
import { asJob } from '../locate.js';
import type { DbfsTableAudit, JobRow } from '../../collect/sql/shapes.js';
import { share } from '../../collect/sql/rows.js';
import {
  bandOutcome,
  bandsOf,
  evidenceFrom,
  fromSignal,
  notApplicable,
  offenders,
  percent,
} from './helpers.js';
import type { SignalId } from '../../collect/signal.js';

const JOBS: SignalId = 'sql:jobs.inventory';
const DBFS_TABLES: SignalId = 'sql:security.dbfs_tables';

/**
 * SCP-04-22: Jobs run as service principal.
 *
 * A job running as a user account inherits that person's grants, outlives their
 * employment, and produces audit entries attributed to an individual rather than to
 * a workload. A service principal can be granted exactly what the job needs,
 * survives staff changes, and names the workload in the audit trail.
 *
 * The `run_as` column was not populated before early December 2025, so jobs with
 * no recorded identity are counted separately rather than treated as failing.
 * The share that decides the verdict is over jobs with a known identity only.
 */
const jobsRunAsSp = fromSignal<JobRow[]>(JOBS, ['SCP-04-22'], (jobs, context) => {
  if (jobs.length === 0) {
    return notApplicable('There are no jobs in this estate, so there is no run-as identity to assess.');
  }

  // A run_as identity is known when the field is a non-empty string. The column is absent
  // on rows written before early December 2025; treating absence as a user account would
  // fail long-standing jobs for a change in the system table, not a change in the estate.
  const known = jobs.filter((job) => job.runAs != null && job.runAs !== '');
  const unknown = jobs.length - known.length;

  if (known.length === 0) {
    return notApplicable(
      `All ${jobs.length.toLocaleString('en-US')} job${jobs.length === 1 ? '' : 's'} in this estate ` +
        'have no run_as identity recorded. This column is not populated for job definitions written ' +
        'before early December 2025; once those jobs are edited or replaced the identity will appear.'
    );
  }

  // An email address identifies a user account. A numeric string (the application ID) identifies
  // a service principal. Any other non-empty value is counted as a service principal because the
  // platform writes the SP application ID as the canonical identifier.
  const userRunJobs = known.filter((job) => job.runAs!.includes('@'));
  const spCount = known.length - userRunJobs.length;
  const spShare = share(spCount, known.length);

  const evidenceSentence =
    `${spCount.toLocaleString('en-US')} of ${known.length.toLocaleString('en-US')} jobs with a recorded identity ` +
    `run as a service principal (${percent(spShare)})` +
    (unknown > 0
      ? `; ${unknown.toLocaleString('en-US')} job${unknown === 1 ? '' : 's'} have no identity recorded yet`
      : '');

  return {
    outcome: bandOutcome(spShare, bandsOf(context.spec, { pass: 1, partial: 0.8 })),
    evidence: [
      evidenceFrom(
        context,
        JOBS,
        evidenceSentence,
        'Every job runs as a service principal, so its permissions are scoped to the workload'
      ),
      ...offenders(context, JOBS, 'Running as a user account', userRunJobs, asJob, {
        note: (job) => job.runAs,
      }),
    ],
    outcomeReason:
      spShare === 1
        ? undefined
        : userRunJobs.length === 1
          ? 'One job runs as a user account. That job inherits its owner’s access, which expands and ' +
            'contracts as their grants change, and becomes a dangling credential if they leave.'
          : `${userRunJobs.length.toLocaleString('en-US')} jobs run as user accounts. Each one inherits its ` +
            'owner’s access, which expands and contracts as their grants change, and becomes a dangling ' +
            'credential if they leave.',
  };
});

/**
 * SCP-04-05: Unity Catalog managed tables stored on DBFS root.
 *
 * A managed table created without an external storage location in an older or
 * misconfigured metastore can end up with its data in `dbfs:/user/hive/warehouse/`,
 * the workspace DBFS root. DBFS root carries no file-level access control: any
 * cluster that can mount it can read or overwrite the data regardless of Unity
 * Catalog grants on the table.
 *
 * The signal queries `system.information_schema.tables`, which covers Unity Catalog
 * managed tables only. Legacy Hive Metastore tables are out of scope because
 * `system.information_schema` cannot see them; the advice for those is to migrate.
 *
 * Zero DBFS-root tables is a clean pass: every managed table in this metastore has
 * its data in a governed cloud location.
 */
const dbfsRootTables = fromSignal<DbfsTableAudit>(DBFS_TABLES, ['SCP-04-05'], (audit, context) => {
  if (audit.totalManagedTables === 0) {
    return notApplicable(
      'This metastore contains no Unity Catalog managed tables (as seen by `system.information_schema`), ' +
        'so there are no storage paths to assess. Legacy Hive Metastore tables are outside the scope of ' +
        'this signal and require migration to Unity Catalog.'
    );
  }

  if (audit.dbfsRootTables === 0) {
    return {
      outcome: 'pass',
      evidence: [
        evidenceFrom(
          context,
          DBFS_TABLES,
          `${audit.totalManagedTables.toLocaleString('en-US')} managed table${audit.totalManagedTables === 1 ? '' : 's'} assessed, none stored on DBFS root`,
          'Every Unity Catalog managed table has its data in a governed cloud location, not on DBFS root'
        ),
      ],
    };
  }

  return {
    outcome: 'fail',
    evidence: [
      evidenceFrom(
        context,
        DBFS_TABLES,
        `${audit.dbfsRootTables.toLocaleString('en-US')} of ${audit.totalManagedTables.toLocaleString('en-US')} Unity Catalog managed table${audit.dbfsRootTables === 1 ? ' has its' : 's have their'} data on DBFS root`,
        'Every Unity Catalog managed table has its data in a governed cloud location, not on DBFS root'
      ),
    ],
    outcomeReason:
      'Data on DBFS root is not governed by Unity Catalog at the file level. Any cluster with access ' +
      'to the workspace DBFS root can read or overwrite this data regardless of catalogue grants, ' +
      'which makes it impossible to enforce least privilege through Unity Catalog alone. Move these ' +
      'tables to a managed storage location or an external location backed by a storage credential.',
  };
});

export const SECURITY_JOBS_RESOLVERS: readonly ControlResolver[] = [jobsRunAsSp, dbfsRootTables];
