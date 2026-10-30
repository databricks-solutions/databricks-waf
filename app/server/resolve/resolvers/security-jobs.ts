// Security controls answered by system-table signals about jobs and Unity Catalog storage.
//
// SCP-04-22 reads `run_as_user_name` from `system.lakeflow.jobs` — the identity jobs execute as —
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

/**
 * The job inventory. The detail evidence that lists the jobs running as a user account carries that
 * account beside each, so `share/projection.ts` knows this id and `RUN_AS_USER_LEAD` and withholds that
 * evidence from readers outside the assessor group.
 */
export const JOBS: SignalId = 'sql:jobs.inventory';

/** The lead of the detail evidence naming the jobs that run as a user account. */
export const RUN_AS_USER_LEAD = 'Running as a user account';

const DBFS_TABLES: SignalId = 'sql:security.dbfs_tables';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a job's run-as name says about the identity it runs as. */
export type RunAsKind = 'user' | 'service-principal' | 'unknown';

/**
 * Classify a run-as name (decision A7 in docs/decisions.md).
 *
 * `run_as_user_name` is the email of a user, the application ID of a service principal, or a group name.
 * An email is a user, and a UUID is a service principal. Anything else, a group name included, cannot be
 * told apart from the others by its shape and is unknown; so is a name that was never recorded. No
 * directory lookup is made to resolve them, because that would add a call and a dependency on an API
 * that not every reader of the estate can use.
 */
export function runAsKind(name: string | undefined): RunAsKind {
  const value = name?.trim() ?? '';
  if (value === '') return 'unknown';
  if (/^[^@\s]+@[^@\s]+$/.test(value)) return 'user';
  if (UUID.test(value)) return 'service-principal';
  return 'unknown';
}

/**
 * SCP-04-22: Jobs run as service principal.
 *
 * A job running as a user account inherits that person's grants, outlives their
 * employment, and produces audit entries attributed to an individual rather than to
 * a workload. A service principal can be granted exactly what the job needs,
 * survives staff changes, and names the workload in the audit trail.
 *
 * The classification reads `run_as_user_name`, which holds the identity's name. `run_as` holds
 * an ID for users and service principals alike and cannot separate them. The name column was
 * not populated before early December 2025, so jobs with no recorded name, and jobs whose name
 * is neither an email nor a service principal ID, are counted as unknown rather than treated as
 * failing or passing. The share that decides the verdict is over jobs classified as one or the
 * other only.
 */
const jobsRunAsSp = fromSignal<JobRow[]>(JOBS, ['SCP-04-22'], (jobs, context) => {
  if (jobs.length === 0) {
    return notApplicable('There are no jobs in this estate, so there is no run-as identity to assess.');
  }

  const userRunJobs = jobs.filter((job) => runAsKind(job.runAsName) === 'user');
  const spCount = jobs.filter((job) => runAsKind(job.runAsName) === 'service-principal').length;
  const classified = userRunJobs.length + spCount;
  const unknown = jobs.length - classified;

  if (classified === 0) {
    return notApplicable(
      `None of the ${jobs.length.toLocaleString('en-US')} job${jobs.length === 1 ? '' : 's'} in this estate ` +
        'has a run-as name that can be classified. This column is not populated for job definitions written ' +
        'before early December 2025, so these jobs have no run-as name recorded or one that is not an email ' +
        'address or a service principal ID, such as a group name; once the jobs are edited or replaced the ' +
        'name will appear.'
    );
  }

  const spShare = share(spCount, classified);

  const evidenceSentence =
    `${spCount.toLocaleString('en-US')} of ${classified.toLocaleString('en-US')} jobs with a recognised identity ` +
    `run as a service principal (${percent(spShare)})` +
    (unknown > 0
      ? `; ${unknown.toLocaleString('en-US')} job${unknown === 1 ? '' : 's'} cannot be classified, ` +
        'with no run-as name recorded or one that is neither an email address nor a service principal ID'
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
      ...offenders(context, JOBS, RUN_AS_USER_LEAD, userRunJobs, asJob, {
        note: (job) => job.runAsName,
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
