// Local-only E2E fixture. Production SQL, scanning, routes and the built client run unchanged;
// only the workspace's SCIM and Statement Execution HTTP responses use synthetic data.
import express from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { servedAt, closeServed } from '../../server/api/test-servers.js';
import { registerApi } from '../../server/api/routes.js';
import { loadCatalogue } from '../../server/catalogue/catalogue.js';
import { loadGuidance } from '../../server/guidance/guidance.js';
import { SqlCollector } from '../../server/collect/sql/collector.js';
import { StatementExecutor } from '../../server/collect/sql/statements.js';
import { buildRegistry } from '../../server/resolve/resolvers/index.js';
import { ScanRunner } from '../../server/scan/runner.js';
import { InMemoryScanStore } from '../../server/scan/store.js';
import { define } from '../../server/define/definition.js';
import { InMemoryDefinitionStore } from '../../server/define/store.js';
import { InMemoryAttestationStore } from '../../server/attest/store.js';
import { InMemoryReviewStore } from '../../server/review/store.js';
import { finalAssessmentProjector } from '../../server/review/projection.js';
import type { AssessmentReviewPayload, ScanPayload } from '../../shared/api/contract.js';

export interface PolicyCluster {
  readonly id: string;
  readonly source: 'UI' | 'API' | 'JOB' | 'PIPELINE' | 'MAINTENANCE';
  readonly policy: boolean;
}

export interface PolicyEstate {
  readonly clusters: readonly PolicyCluster[];
  readonly unreadable?: boolean;
}

export const FIXTURE_HEADERS = {
  'content-type': 'application/json',
  'x-forwarded-access-token': 'synthetic-local-test-token',
  'x-forwarded-email': 'assessor@example.com',
};

export async function serveComputePolicyApp() {
  const servers: Server[] = [];
  let estate: PolicyEstate = { clusters: [] };
  const statements: string[] = [];
  const workspace = express();
  workspace.use(express.json());
  workspace.use((request, response, next) => {
    if (request.header('authorization') !== `Bearer ${FIXTURE_HEADERS['x-forwarded-access-token']}`) {
      response.status(401).json({ error: 'synthetic-workspace-token-required' });
      return;
    }
    next();
  });
  workspace.get('/api/2.0/preview/scim/v2/Me', (_request, response) => {
    response.setHeader('x-databricks-org-id', '123');
    response.json({ userName: 'assessor@example.com', groups: [{ display: 'waf-assessors' }] });
  });
  workspace.post('/api/2.0/sql/statements', (request, response) => {
    const body: unknown = request.body;
    if (body == null || typeof body !== 'object' || !('statement' in body) || typeof body.statement !== 'string') {
      response.status(400).json({ error: 'statement-required' });
      return;
    }
    const statement = body.statement;
    const signal = /-- Signal: (\S+)/.exec(statement)?.[1] ?? 'unknown';
    statements.push(signal);
    if (signal === 'sql:compute.clusters' && estate.unreadable === true) {
      response.json({
        status: {
          state: 'FAILED',
          error: { error_code: 'PERMISSION_DENIED', message: 'Synthetic inventory permission refusal' },
        },
      });
      return;
    }
    let rows: Record<string, string>[] = [];
    if (signal === 'sql:compute.clusters') {
      rows = estate.clusters.map((cluster) => ({
        workspace_id: '123',
        cluster_id: cluster.id,
        cluster_name: cluster.id,
        cluster_source: cluster.source,
        has_policy: String(cluster.policy),
        dbr_version: '17.3.x-scala2.13',
        autoscaling: 'false',
        auto_terminates: 'true',
        init_scripts_known: 'true',
        dbfs_init_script_count: '0',
        init_script_count: '0',
        worker_count: '2',
        min_workers: '0',
        max_workers: '0',
        tag_count: '1',
      }));
    }
    const columns = Object.keys(rows[0] ?? {});
    response.json({
      statement_id: `synthetic-${statements.length}`,
      status: { state: 'SUCCEEDED' },
      manifest: {
        total_row_count: rows.length,
        total_byte_count: 100,
        schema: {
          columns: columns.map((name) => ({ name, type_name: 'STRING' })),
        },
      },
      result: { data_array: rows.map((row) => columns.map((column) => row[column])), row_count: rows.length },
    });
  });
  try {
    const workspaceUrl = await servedAt(workspace, servers);
    const catalogue = loadCatalogue();
    const registry = buildRegistry();
    const store = new InMemoryScanStore();
    const pillars = ['operational-excellence', 'interoperability-and-usability'];
    const attestations = new InMemoryAttestationStore();
    const definitions = new InMemoryDefinitionStore();
    const definitionId = 'synthetic-compute-policy-assessment';
    await definitions.create(
      define(
        {
          measurement: { scope: { kind: 'account' }, lookbackDays: 30, pillars },
          attribution: { name: 'Synthetic compute policy E2E', owners: ['assessor@example.com'] },
        },
        definitionId,
        new Date(),
        'assessor@example.com'
      )
    );
    const scopeQuery = `?definitionId=${definitionId}`;
    const reviews = new InMemoryReviewStore({
      pillars,
      projection: {
        project: finalAssessmentProjector({ catalogue, registry }),
        scan: (id) => store.get(id),
        attestation: (id, scope) => attestations.get(id, scope),
      },
    });
    const runner = new ScanRunner({ catalogue, registry, store, measuredPillars: pillars, attestations });
    const app = express();
    app.use(express.json());
    registerApi(app, {
      catalogue,
      registry,
      runner,
      store,
      pillars,
      attestations,
      definitions,
      reviews,
      guidance: loadGuidance(),
      host: workspaceUrl,
      assessorGroup: 'waf-assessors',
      warehouse: () => 'synthetic-warehouse',
      collectorsFor: ({ credentials, scope, lookbackDays }) => [
        new SqlCollector({
          scope,
          lookbackDays,
          executor: async (statement, parameters, signal) => {
            const identity = await credentials.databricks();
            return new StatementExecutor({
              host: identity.host,
              token: identity.token,
              warehouseId: 'synthetic-warehouse',
            }).query(statement, parameters, signal);
          },
        }),
      ],
    });
    app.use('/api', (_request, response) => {
      response.status(404).json({ error: 'unknown-api-route' });
    });
    const client = fileURLToPath(new URL('../../client/dist/', import.meta.url));
    app.use(express.static(client));
    app.use((_request, response) => {
      response.sendFile(`${client}index.html`, { dotfiles: 'allow' });
    });
    const origin = await servedAt(app, servers);
    return {
      origin,
      statements,
      scopeQuery,
      async scan(next: PolicyEstate): Promise<ScanPayload> {
        estate = next;
        const response = await fetch(`${origin}/api/scan${scopeQuery}`, {
          method: 'POST',
          headers: FIXTURE_HEADERS,
          body: '{}',
        });
        const body = (await response.json()) as ScanPayload;
        if (response.status !== 200) throw new Error(`Scan returned ${response.status}: ${JSON.stringify(body)}`);
        return body;
      },
      async publish(scan: ScanPayload): Promise<AssessmentReviewPayload> {
        const opened = await fetch(`${origin}/api/reviews${scopeQuery}`, {
          method: 'POST',
          headers: FIXTURE_HEADERS,
          body: JSON.stringify({ runId: scan.id }),
        });
        let review = (await opened.json()) as AssessmentReviewPayload;
        if (opened.status !== 201) throw new Error(`Review open failed: ${JSON.stringify(review)}`);
        // Keep unrelated unanswered practices explicitly skipped. Measured policy findings retain
        // their outcomes in the production final-assessment projection, without fabricated answers.
        for (const pillar of pillars) {
          const response = await fetch(`${origin}/api/reviews/${review.id}/pillars/${pillar}/skip${scopeQuery}`, {
            method: 'POST',
            headers: FIXTURE_HEADERS,
            body: '{}',
          });
          review = (await response.json()) as AssessmentReviewPayload;
          if (response.status !== 201) throw new Error(`Review decision failed: ${JSON.stringify(review)}`);
        }
        if (review.result == null) throw new Error('Review did not publish a frozen result');
        return review;
      },
      close: () => closeServed(servers),
    };
  } catch (error) {
    await closeServed(servers);
    throw error;
  }
}
