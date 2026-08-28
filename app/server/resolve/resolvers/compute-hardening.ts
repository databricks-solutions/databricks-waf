// Three security-guide controls about clusters, answered from the cluster inventory the
// cost pillar already collects.
//
// The security guide names a control-plane endpoint for each of these — `clusters/list`,
// `clusters/spark-versions`, `dbfs/list` — and ADR 0016 established that no install of this
// app can be authorised to call any of them. That looked like the end of it. It was not:
// `system.compute.clusters` carries the runtime, the access mode and the init-script
// destinations of every cluster in the account, and the app already reads that table for six
// cost controls. So the answer was already on the wire, being thrown away.
//
// Worth stating plainly because it generalises. A control marked `rest-api` in the catalogue
// records where the *security guide* got its answer, not where the only answer is. Three high
// severity requirements moved from unmeasurable to measured here at no additional query cost,
// and the reason they were unmeasurable was a provenance note being read as a constraint.
//
// The system table is also the better source, not merely an available one. It is
// account-scoped, so one install answers for every workspace in the account, where the REST
// endpoints are workspace-scoped and would need one install each (ADR 0015).
//
// What it cannot do is answer for a column the platform has not written. `data_security_mode`
// is unpopulated for cluster rows older than late 2025 — measured: zero of twenty on the
// development workspace — so the access-mode control reports unmeasured rather than failing an
// estate whose clusters simply have not been edited recently. Guessing would have produced a
// high severity failure from a system-table rollout date.

import type { ControlResolver } from '../resolver.js';
import { asCluster } from '../locate.js';
import type { ClusterRow } from '../../collect/sql/shapes.js';
import { isAllPurpose } from '../../collect/sql/shapes.js';
import { share } from '../../collect/sql/rows.js';
import {
  bandOutcome,
  bandsOf,
  evidenceFrom,
  fromSignal,
  offenders,
  notApplicable,
  threshold,
  unmeasured,
} from './helpers.js';

const CLUSTERS = 'sql:compute.clusters';

/**
 * SCP-04-04: runtimes past end of support.
 *
 * Deliberately a different question from CO-01-04, which asks whether clusters are on a
 * *current* runtime and treats 14 as the floor. This asks whether any cluster is on a runtime
 * Databricks no longer supports, which is a security finding rather than an efficiency one:
 * an unsupported runtime stops receiving patches, so a CVE in it is permanent. The cost
 * control's floor is an aspiration and this one is a line, and an estate can reasonably sit
 * between them — on 13.3 LTS, behind the recommendation and still supported.
 *
 * The line is a threshold in the catalogue rather than a constant here, because it moves
 * roughly annually and a number in code would be quietly wrong for months. Anything at or
 * above it is supported; below it is not.
 */
const deprecatedRuntimes = fromSignal<ClusterRow[]>(CLUSTERS, ['SCP-04-04'], (clusters, context) => {
  const population = clusters.filter(isAllPurpose);
  if (population.length === 0) {
    return notApplicable(
      'This estate runs no classic all-purpose clusters, so there is no runtime whose support window ' +
        'could have closed. Serverless compute is patched by Databricks and has no version to keep current.'
    );
  }

  /*
   * A runtime whose version cannot be parsed is not evidence of a supported one.
   *
   * It is counted as unsupported rather than skipped, which is the conservative direction and
   * the defensible one: the alternative is that a runtime string this app does not recognise
   * silently drops out of the denominator, and an estate running entirely on something
   * unrecognised would pass on a population of zero.
   */
  const floor = threshold(context.spec, 'min_supported_runtime_major', 14);
  const unsupported = population.filter((cluster) => majorVersion(cluster.runtime) < floor);
  const supported = share(population.length - unsupported.length, population.length);

  return {
    outcome: bandOutcome(supported, bandsOf(context.spec, { pass: 1, partial: 0.9 })),
    evidence: [
      evidenceFrom(
        context,
        CLUSTERS,
        `${unsupported.length} of ${population.length} all-purpose clusters run a runtime below ${String(floor)}` +
          (unsupported.length > 0 ? `: ${oldestFirst(unsupported).slice(0, 5).join(', ')}` : ''),
        `Every all-purpose cluster runs Databricks Runtime ${String(floor)} or later, which is still supported`
      ),
    ],
    outcomeReason:
      `Runtime ${String(floor)} is treated as the oldest supported major version. A cluster below it no longer ` +
      'receives security patches, so a vulnerability disclosed against it stays open until the cluster is ' +
      'upgraded. The band is deliberately unforgiving — one unpatched cluster is one unpatched cluster, and ' +
      'nine tenths of an estate being current does not close it.',
  };
});

/**
 * SCP-04-07: clusters that can reach Unity Catalog.
 *
 * A cluster in no-isolation or legacy mode bypasses Unity Catalog's grants entirely: whoever
 * can attach to it reads whatever the cluster's identity can reach, and no `GRANT` written in
 * UC has any effect on them. So this is not a governance nicety — it is a hole in every access
 * decision the metastore makes.
 *
 * Reads `data_security_mode`, which the platform leaves unwritten on older cluster rows. That
 * case is reported unmeasured with the reason stated, because the alternative is failing an
 * estate for the age of its system-table rows.
 */
const accessModes = fromSignal<ClusterRow[]>(CLUSTERS, ['SCP-04-07'], (clusters, context) => {
  const population = clusters.filter(isAllPurpose);
  if (population.length === 0) {
    return notApplicable(
      'This estate runs no classic all-purpose clusters. Serverless compute is always Unity Catalog ' +
        'governed and has no access mode to set.'
    );
  }

  const known = population.filter((cluster) => cluster.dataSecurityMode != null);
  if (known.length === 0) {
    return unmeasured(
      `None of the ${String(population.length)} all-purpose clusters in this estate record an access mode. ` +
        '`system.compute.clusters.data_security_mode` is only written for clusters created or edited since ' +
        'the column was added, so an estate of long-lived clusters leaves it empty. That is a gap in the ' +
        'system table rather than a finding about the clusters: reading an unwritten column as ' +
        '"no isolation" would report a high severity failure caused by a rollout date. Editing any ' +
        'setting on a cluster writes a fresh row and makes it readable.'
    );
  }

  const governed = known.filter((cluster) => isUnityCatalogMode(cluster.dataSecurityMode));
  const adopted = share(governed.length, known.length);
  const bypassing = known.filter((cluster) => !isUnityCatalogMode(cluster.dataSecurityMode));

  return {
    outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 1, partial: 0.8 })),
    evidence: [
      evidenceFrom(
        context,
        CLUSTERS,
        `${governed.length} of ${known.length} all-purpose clusters with a recorded access mode are Unity ` +
          `Catalog enabled`,
        'Every all-purpose cluster runs in a Unity Catalog access mode, so metastore grants apply to it'
      ),
      ...offenders(context, CLUSTERS, 'Bypassing it', bypassing, asCluster, {
        note: (cluster) => cluster.dataSecurityMode ?? 'unset',
      }),
    ],
    ...(known.length < population.length
      ? {
          outcomeReason:
            `Measured over the ${String(known.length)} of ${String(population.length)} all-purpose clusters that ` +
            'record an access mode. The rest predate the column in `system.compute.clusters` and are left out of ' +
            'the ratio rather than assumed compliant or assumed not.',
        }
      : {
          outcomeReason:
            'A cluster in a legacy or no-isolation access mode does not consult Unity Catalog grants at all, so ' +
            'every permission written in the metastore is unenforced for anyone who can attach to it. One such ' +
            'cluster is enough to make the metastore advisory.',
        }),
  };
});

/**
 * SCP-04-16: init scripts on DBFS.
 *
 * An init script runs as root on every node before the cluster is usable, and DBFS has no
 * access control worth the name — anyone who can write to the path can change what runs.
 * That combination is the finding: it is a remote code execution route that does not require
 * cluster permissions.
 *
 * The security guide reads this by listing `/databricks/init`, the legacy *global* location.
 * This reads every cluster's own init-script destinations, which covers the global case and
 * the far more common cluster-scoped one that the endpoint would miss entirely.
 */
const initScripts = fromSignal<ClusterRow[]>(CLUSTERS, ['SCP-04-16'], (clusters, context) => {
  if (clusters.length === 0) {
    return notApplicable(
      'This estate runs no classic clusters, so there are no init scripts. Serverless compute does not ' +
        'run them.'
    );
  }

  const known = clusters.filter((cluster) => cluster.initScriptsKnown);
  if (known.length === 0) {
    return unmeasured(
      `None of the ${String(clusters.length)} clusters in this estate record their init scripts. ` +
        '`system.compute.clusters.init_scripts` is empty rather than absent for a cluster with none, so an ' +
        'unwritten column means the platform did not report them — not that there are none. Treating that ' +
        'as "no init scripts" would pass every cluster in an estate the app could not see into.'
    );
  }

  const offending = known.filter((cluster) => cluster.dbfsInitScriptCount > 0);
  const clean = share(known.length - offending.length, known.length);
  const total = offending.reduce((sum, cluster) => sum + cluster.dbfsInitScriptCount, 0);

  return {
    outcome: bandOutcome(clean, bandsOf(context.spec, { pass: 1, partial: 0.95 })),
    evidence: [
      evidenceFrom(
        context,
        CLUSTERS,
        offending.length === 0
          ? `No init script on any of the ${String(known.length)} clusters examined runs from a DBFS root`
          : `${String(total)} init script${total === 1 ? '' : 's'} across ${String(offending.length)} of ` +
            `${String(known.length)} clusters run from a DBFS root`,
        'No cluster runs an init script from a DBFS root'
      ),
      ...offenders(context, CLUSTERS, 'Running from DBFS', offending, asCluster),
    ],
    outcomeReason:
      'Init scripts under `/Volumes` or `/Workspace` are governed and are not counted here; only DBFS roots ' +
      'are, because DBFS is the location with no meaningful access control. A destination this app does not ' +
      'recognise counts as governed rather than as suspicious, so the finding understates rather than ' +
      'invents. Support for DBFS init scripts has been withdrawn, so this is a migration as well as a fix.' +
      (known.length < clusters.length
        ? ` Measured over the ${String(known.length)} of ${String(clusters.length)} clusters whose init scripts ` +
          'the system table records.'
        : ''),
  };
});

export const COMPUTE_HARDENING_RESOLVERS: readonly ControlResolver[] = [
  deprecatedRuntimes,
  accessModes,
  initScripts,
];

/**
 * The leading integer of a runtime string such as `14.3.x-photon-scala2.12`.
 *
 * Zero when it cannot be read, which counts the cluster as unsupported. See the note in
 * `deprecatedRuntimes` on why that direction rather than dropping it from the population.
 */
function majorVersion(runtime: string | undefined): number {
  const match = /^(\d+)/.exec(runtime ?? '');
  return match == null ? 0 : Number(match[1]);
}

/**
 * Whether an access mode consults Unity Catalog.
 *
 * Matched against the modes that do, rather than against the ones that do not, because the
 * platform adds modes and the two directions fail differently: an unrecognised new mode read
 * as governed would silently pass a cluster nobody has assessed, where read as ungoverned it
 * produces a visible finding a reader can correct. The visible error is the better one.
 *
 * `SINGLE_USER` and `USER_ISOLATION` are the two current spellings; `DATA_SECURITY_MODE_AUTO`
 * and `DATA_SECURITY_MODE_DEDICATED` are the newer names for the same intent. `NONE`,
 * `LEGACY_PASSTHROUGH`, `LEGACY_TABLE_ACL`, `LEGACY_SINGLE_USER` and their variants all
 * bypass the metastore.
 */
function isUnityCatalogMode(mode: string | undefined): boolean {
  if (mode == null) return false;
  const upper = mode.toUpperCase();
  return (
    upper === 'SINGLE_USER' ||
    upper === 'USER_ISOLATION' ||
    upper === 'DATA_SECURITY_MODE_AUTO' ||
    upper === 'DATA_SECURITY_MODE_STANDARD' ||
    upper === 'DATA_SECURITY_MODE_DEDICATED'
  );
}

/** Worst offenders first, so a truncated list names the oldest runtimes rather than the first five. */
function oldestFirst(clusters: readonly ClusterRow[]): string[] {
  return [...clusters]
    .sort((a, b) => majorVersion(a.runtime) - majorVersion(b.runtime))
    .map((cluster) => `${cluster.name} on ${cluster.runtime ?? 'an unrecorded runtime'}`);
}
