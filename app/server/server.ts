// The app's entry point.
//
// Two things happen here that are worth reading twice.
//
// The SQL executor is built per scan from that scan's credentials, not once at startup.
// That is what makes every statement run as the signed-in user rather than as the app's
// service principal, so a user who cannot read a system table gets an assessment that
// says so instead of one built from someone else's access.
//
// And a startup failure serves a page that names what is missing. The default
// behaviour — `createApp` throwing and the process exiting — means a consuming admin
// who binds resources wrongly during an install gets a dead app and a stack
// trace in a log they may not be able to reach.

import { analytics, createApp, server } from '@databricks/appkit';
import { configuredGroup } from './authorize/group.js';
import { loadCatalogue } from './catalogue/catalogue.js';
import { loadGuidance } from './guidance/guidance.js';
import { SqlCollector, type SqlExecutor } from './collect/sql/collector.js';
import { DescribeCollector } from './collect/sql/describe.js';
import { PredictiveOptimizationCollector } from './collect/sql/predictive-optimization.js';
import { clientFor } from './collect/rest/client.js';
import { RestCollector } from './collect/rest/collector.js';
import { CloudCollector } from './collect/cloud/collector.js';
import { workspaceHost } from './collect/credentials.js';
import { declaredScopes } from './collect/rest/declared-scopes.js';
import { StatementExecutor } from './collect/sql/statements.js';
import { buildRegistry } from './resolve/resolvers/index.js';
import { registerApi } from './api/routes.js';
import { machineClient } from './schedule/client.js';
import { AuditRecorder, postureFrom } from './audit/record.js';
import { ScanRunner } from './scan/runner.js';
import { Runs } from './run/runs.js';
import { AdvisoryRunner } from './advise/runner.js';
import { resolveValidations } from './validate/resolve.js';
import { settleAdvice } from './improve/advice-settle.js';
import { chooseStore } from './scan/store-choice.js';
import { openedFor } from './review/review.js';
import { finalAssessmentProjector } from './review/projection.js';
import { startFallbackServer } from './api/fallback.js';

/**
 * Pillars the app measures today.
 *
 * Named rather than inferred, so the UI can say which pillars are assessed instead of
 * showing one at zero and letting the reader assume the estate failed it.
 *
 * All seven, as of the operational-excellence and interoperability resolvers. Those two
 * were the last holdouts and were absent for a reason worth recording: both arrived from
 * the seed with every control marked `attestation`, on the reasoning that their published
 * text is about process and a process is not a system table. That was true of about two
 * thirds of them and false of the rest — "use Unity Catalog managed tables", "use
 * declarative pipelines", "use open data formats" each name an artefact the metastore
 * records plainly. Nineteen controls were measured by looking again, so the list is now
 * the whole framework and this constant's remaining job is to be the thing a reviewer
 * checks against the registry rather than a gate anything sits behind.
 */
const MEASURED_PILLARS = [
  'cost-optimization',
  'data-and-ai-governance',
  'interoperability-and-usability',
  'operational-excellence',
  'performance-efficiency',
  'reliability',
  'security-compliance-and-privacy',
] as const;

/**
 * The guidance library, or nothing when it cannot be read.
 *
 * Swallowed on purpose. Guidance makes a question easier to answer honestly; it is not what makes
 * the question answerable. An install whose `config/guidance/` directory is missing should serve the
 * assessment and say no guidance was written, not refuse to boot over a content directory.
 */
function readGuidance(): ReturnType<typeof loadGuidance> | undefined {
  try {
    const library = loadGuidance();
    console.log(`[guidance] ${library.authored} of ${library.entries.size} entries are written`);
    return library;
  } catch (error) {
    console.error('[guidance] could not be read, questions will show none:', error);
    return undefined;
  }
}

async function main(): Promise<void> {
  const catalogue = loadCatalogue();
  // Read once at boot rather than per request. Guidance is content that changes when the app is
  // deployed, and a directory that failed to ship should be one log line here rather than a
  // stack trace on every requirement pane a reader opens.
  const guidance = readGuidance();
  const registry = buildRegistry();
  const projector = finalAssessmentProjector({ catalogue, registry });
  // Before the store is opened, because it is the cheapest thing that can refuse the boot and
  // there is no reason to acquire a connection pool on the way to serving an explanation page.
  const assessorGroup = configuredGroup();
  console.log(`[authorize] changes are restricted to members of the ${assessorGroup} group`);
  const {
    store,
    attestations,
    decisions,
    definitions,
    drafts,
    imports,
    audit: auditLog,
    improvements,
    improvementExplanation: improvementStorage,
    notes,
    noteExplanation: noteStorage,
    serving,
    servingExplanation: servingStorage,
    reviews,
    reviewExplanation: reviewStorage,
    validations,
    validationExplanation: validationStorage,
    risks,
    riskExplanation: riskStorage,
    applicability: applicabilityStore,
    explanation: storage,
    attestationExplanation: attestationStorage,
    decisionExplanation: decisionStorage,
    definitionExplanation: definitionStorage,
    verify: verifyRecords,
    ping: pingDatabase,
    retention: retentionStore,
    retentionGateway,
    runs: runStore,
    advisories: advisoryStore,
    planExtracts,
    publications: publicationStore,
    close: closeStore,
  } = await chooseStore({
    pillars: catalogue.pillars.map((pillar) => pillar.id),
    projector,
    onError: (operation, error) => {
      // Logged rather than thrown. A store that cannot be read is a degraded history, not
      // a broken assessment, and the scan that was just run is still on screen.
      console.error(`[scan store] could not ${operation}:`, error);
    },
  });
  // The app's own identity, resolved once. Reported like the stores are, because "the app cannot see
  // its own scheduled job" is a thing an operator reading `databricks apps logs` needs to find without
  // opening a page — and on a customer install it means the bundle's job grant did not land.
  const machine = machineClient();
  console.log(
    `[schedule] ${machine == null ? 'no machine identity; the scheduled job cannot be read' : 'reading the scheduled job as the app'}`
  );
  console.log(`[scan store] ${storage}`);
  console.log(`[attestations] ${attestationStorage}`);
  console.log(`[decisions] ${decisionStorage}`);
  console.log(`[definitions] ${definitionStorage}`);
  console.log(`[improvements] ${improvementStorage}`);
  console.log(`[notes] ${noteStorage}`);
  console.log(`[serving declarations] ${servingStorage}`);
  console.log(`[reviews] ${reviewStorage}`);
  console.log(`[validations] ${validationStorage}`);
  console.log(`[accepted risks] ${riskStorage}`);
  // One recorder for the process, so `unrecorded` counts everything this app failed to write down
  // rather than resetting per request. `onError` goes to the console for the reason the refusal line
  // does: the one place a failure to record can be reported is somewhere other than the log.
  const audit = new AuditRecorder(auditLog, {
    onError: (operation, error) => {
      console.error(`[audit] could not ${operation}:`, error);
    },
    // Read once, here, rather than where it is enforced. A setting this consequential should be
    // settled at boot and printed, so the log of a strict install says so on the line above the first
    // request — an operator diagnosing refused mutations should not have to infer the posture from
    // them. ADR 0046's amendment.
    posture: postureFrom(process.env),
  });
  console.log(
    `[audit] ${audit.posture === 'strict' ? 'an action that cannot be recorded is refused' : 'an action that cannot be recorded still stands, and is counted'}`
  );
  const runner = new ScanRunner({
    catalogue,
    registry,
    store,
    attestations,
    // So a scan resolves against what administrators imported as well as what it read itself. The
    // ordering rule lives in `import/signals`: an import fills a gap and never overwrites a reading.
    imports,
    // So a scan takes out of the score what the customer marked not applicable or disabled, and carries
    // the exposure of it. Absent on an in-memory install, which has no exclusion path at all, so a scan
    // there applies nothing — the honest behaviour for an install that cannot record a decision either.
    ...(applicabilityStore == null ? {} : { applicability: applicabilityStore }),
    measuredPillars: MEASURED_PILLARS,
    // Read from the shipped `app.yaml` so a finding refused for want of a scope can say
    // whether re-authorising would help. Without it every scope refusal reports as permanent,
    // which is the safe reading but understates what one click would fix.
    declaredScopes: declaredScopes(),
    // The only path that reaches `verified`. Here rather than in the route that starts a scan, because
    // a scheduled run has to answer the claims waiting on it too, and a scan is started from three
    // places. It cannot fail the scan — see `settled` in the runner.
    onFinished: async (scan) => {
      const settled = await resolveValidations(scan, {
        validations,
        improvements,
        onError: (operation, error) => {
          console.error(`[validations] could not ${operation}:`, error);
        },
      });
      if (settled.answered > 0 || settled.withdrawn > 0) {
        console.log(
          `[validations] ${String(settled.answered)} answered by ${scan.id} ` +
            `(${String(settled.verified)} verified, ${String(settled.failed)} still failing, ` +
            `${String(settled.incomplete)} unfinished), ${String(settled.withdrawn)} withdrawn, ` +
            `${String(settled.waiting)} still waiting`
        );
      }
      // Its own line rather than a number in the one above, because it is the only part of a resolution
      // somebody has to do something about: the claim holds and the board still shows it as work in
      // hand, and the way out is to ask for another validation.
      if (settled.stalled > 0) {
        console.error(
          `[validations] ${String(settled.stalled)} validations passed and could not be recorded as verified. ` +
            'The attempts are on the record; ask for another validation of those actions.'
        );
      }
      // Completing a scan opens a review of that scan and does nothing else. A failure here is
      // logged rather than thrown: the scan is already saved, and refusing it because a review
      // could not be opened would turn a finished measurement into a scan the caller is told failed.
      try {
        await reviews.open(openedFor(scan, { id: crypto.randomUUID() }));
      } catch (error) {
        console.error(`[reviews] could not open a review of ${scan.id}:`, error);
      }
    },
  });

  // Absent with the store, so the demo case triggers scans the way it did before this existed rather
  // than through a coordinator with nowhere to record anything. See `runs` in `chooseStore`.
  // The advisor, where there is somewhere to keep what it concludes. Both or neither: a coordinator
  // that could start an advisory run with nowhere to write it would produce a run that finished having
  // saved nothing, which presents as the advisor being broken rather than absent.
  const advisor =
    advisoryStore == null
      ? undefined
      : new AdvisoryRunner({
          store: advisoryStore,
          ...(planExtracts != null ? { planExtracts } : {}),
          // The only path that clears work raised from advisor advice, and the counterpart of the scan
          // runner's `onFinished` above: a WAF claim is answered by the next scan, and an advice-raised
          // action by the next advisory. Here rather than in the route, because a scheduled advisory
          // has to answer the work waiting on it too.
          onFinished: async (advisory) => {
            const settled = await settleAdvice(advisory, {
              improvements,
              onError: (operation, error) => {
                console.error(`[advice] could not ${operation}:`, error);
              },
            });
            if (settled.cleared > 0 || settled.firing > 0) {
              console.log(
                `[advice] ${String(settled.cleared)} cleared by ${advisory.id}, ` +
                  `${String(settled.firing)} still firing, ${String(settled.unreadable)} unreadable`
              );
            }
            // Its own line, for the same reason the validations path gives one: the action stays on
            // somebody's board as work in hand, and nothing about the next advisory changes that.
            if (settled.stalled > 0) {
              console.error(
                `[advice] ${String(settled.stalled)} actions cleared and could not be recorded as verified. ` +
                  'They remain waiting; the next advisory will settle them.'
              );
            }
          },
        });
  const runs =
    runStore == null ? undefined : new Runs({ store: runStore, runner, ...(advisor != null ? { advisor } : {}) });
  console.log(
    `[runs] ${
      runs == null
        ? 'a run is not stored durably; an interrupted run is lost'
        : 'a run is recorded before it starts, and a retry carries on where it stopped'
    }`
  );

  const host = workspaceHost();

  // The analytics plugin stays registered even though collection no longer runs
  // through it: it declares the sql-warehouse resource requirement and performs the
  // startup handshake, which is what gives a misconfigured install something specific
  // to say. See statements.ts for why the queries do not use its asUser path.
  //
  // Wrapped so that a startup failure releases the connection pool the store just acquired. The
  // retry at the bottom of this file calls `main` again every thirty seconds, and the failure most
  // likely to arrive here — no warehouse bound — happens *after* the database connected. Without
  // this, each attempt would strand a pool of ten connections and the app would eventually be
  // refused by Lakebase for a reason unrelated to the binding the admin was trying to fix.
  try {
    await createApp({
      plugins: [analytics(), server()],
      onPluginsReady(appkit) {
        appkit.server.extend((app) => {
          registerApi(app, {
            catalogue,
            registry,
            runner,
            ...(runs == null ? {} : { runs }),
            store,
            storage,
            attestations,
            attestationStorage,
            decisions,
            decisionStorage,
            definitions,
            drafts,
            imports,
            definitionStorage,
            improvements,
            improvementStorage,
            notes,
            noteStorage,
            serving,
            servingStorage,
            reviews,
            reviewStorage,
            validations,
            validationStorage,
            risks,
            riskStorage,
            host,
            assessorGroup,
            audit,
            // Built once for the process, not per request, because it is one identity — the app's own —
            // and per-request construction would resolve the same credentials on every page load.
            // Absent where this install has no identity of its own, and the schedule surface says so.
            ...(machine == null ? {} : { machineClient: machine }),
            pillars: MEASURED_PILLARS,
            // Absent when the directory failed to ship, and the route says no guidance was written
            // rather than failing the pane that shows the question.
            ...(guidance == null ? {} : { guidance }),
            // Absent in the demo case, and the route says "nothing is stored" rather than "verified".
            ...(verifyRecords == null ? {} : { verifyRecords }),
            // Absent in the demo case too, and the diagnostics page reads that as no database bound
            // rather than as one that failed to answer.
            ...(pingDatabase == null ? {} : { pingDatabase }),
            // Both or neither, so an install with nothing stored gets no retention surface at all
            // rather than one whose periods govern nothing and whose sweep removes nothing.
            ...(retentionStore == null || retentionGateway == null
              ? {}
              : { retention: { store: retentionStore, gateway: retentionGateway } }),
            // Absent means the Optimisation endpoints say this build has no advisor, which is the
            // honest answer for an install with nothing durable bound — see `advisories` on
            // `StoreChoice` for why advice with nowhere to keep it is worse than no advice.
            ...(advisoryStore == null ? {} : { advisories: advisoryStore }),
            // Absent on an in-memory install, and the monthly endpoints say so rather than accepting a
            // publication the next restart would lose — a published month has to still be here months
            // later to be worth anything. See `publications` on `StoreChoice`.
            ...(publicationStore == null ? {} : { publications: publicationStore }),
            // Absent on an in-memory install, and the applicability routes say so rather than accepting a
            // decision the next restart would lose — which would put a requirement a customer excluded
            // back into their score with nothing recording it. See `applicability` on `StoreChoice`.
            ...(applicabilityStore == null ? {} : { applicability: applicabilityStore }),
            // Reported rather than only used, so a finding names the warehouse its number was read
            // on. Swallowing the unbound case here: the scan is about to fail on the same condition
            // with a sentence the admin can act on, and provenance is not the place to raise it.
            warehouse: () => {
              try {
                return warehouseId();
              } catch {
                return undefined;
              }
            },
            collectorsFor: ({ credentials, scope, lookbackDays }) => {
              const executor: SqlExecutor = async (statement, parameters, signal) => {
                const databricks = await credentials.databricks();
                return new StatementExecutor({
                  host: databricks.host,
                  warehouseId: warehouseId(),
                  token: databricks.token,
                }).query(statement, parameters, signal);
              };

              // Order matters here, and only here. Both per-object collectors read a
              // signal the system-table collector produces — the table sample, and the
              // list of catalogs worth describing — so it must run first. Each checks
              // rather than assumes, and reports why if its input is missing.
              return [
                new SqlCollector({ executor, scope, lookbackDays }),
                new DescribeCollector({ executor }),
                new PredictiveOptimizationCollector({ executor }),
                // Same credentials as the statement executor above, deliberately: these
                // endpoints report the workspace's security configuration, and reading them
                // as anything other than the signed-in user would show a reader an estate
                // they have no right to see. See collect/rest/client.ts.
                new RestCollector({ client: clientFor(credentials) }),
                new CloudCollector(),
              ];
            },
          });
        });
      },
    });
  } catch (cause) {
    await closeStore?.().catch(() => undefined);
    throw cause;
  }
}

/**
 * The warehouse the consuming admin bound at install time.
 *
 * Read per scan rather than captured at startup so that rebinding the resource takes
 * effect on the next scan rather than on the next restart. Absent means the binding is
 * missing, which is a sentence the admin can act on rather than a request that fails
 * with a 400 from the warehouse.
 */
function warehouseId(): string {
  const id = process.env.DATABRICKS_WAREHOUSE_ID?.trim();
  if (id == null || id === '') {
    throw new Error(
      'No SQL warehouse is bound to this app, so there is nothing to run the assessment queries on. ' +
        'Bind a warehouse to the app resource named sql-warehouse and run the scan again.'
    );
  }
  return id;
}

/**
 * The backstop for what no request owns.
 *
 * The containment proxy in `api/contain.ts` covers the route path, which is where row 89's outage came
 * from. This covers what has no request to fail: a rejection from a timer, a stream, the scheduler
 * between runs, or a store the app talks to outside a handler. Node's default for both of these is to
 * terminate, and a terminated app here does not come back on its own — measured on labs, it stayed
 * down until a hand redeploy, because `apps start` alone left the deployment association cleared.
 *
 * **Not exiting reverses Node's default, and that is a judgement rather than an oversight.**
 * [ADR 0095](../../docs/decisions/0095-a-fault-with-no-request-logs-and-the-app-keeps-serving.md)
 * records it: a read-path defect in one route is not evidence that the pool, the scheduler or the
 * audit log are unsound, and 502 for every reader is a worse answer than a stack in the log. The
 * opposite call is defensible, which is exactly why it is written down rather than implied by the
 * absence of a handler.
 *
 * Registered before `main` so a fault during startup is covered too, and outside it so a retry does
 * not stack a second pair of listeners on every attempt.
 */
function logAndKeepServing(kind: 'unhandledRejection' | 'uncaughtException', cause: unknown): void {
  console.error(
    `${kind} with no request to answer. The app is still serving; this was not answered by anybody.`,
    cause instanceof Error ? cause.stack : cause
  );
}

process.on('unhandledRejection', (cause: unknown) => {
  logAndKeepServing('unhandledRejection', cause);
});

process.on('uncaughtException', (cause: unknown) => {
  logAndKeepServing('uncaughtException', cause);
});

main().catch((cause: unknown) => {
  // Reached when AppKit's startup handshake fails, which in practice means a resource
  // the app declares was not bound at install time. Rather than exit, serve an
  // explanation and keep retrying, so the admin sees what to fix in the UI they are
  // already looking at.
  startFallbackServer(cause, { retry: main });
});
