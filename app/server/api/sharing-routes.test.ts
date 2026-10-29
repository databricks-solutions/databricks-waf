// Who may read what the app has stored, over a real socket and the whole API.
//
// Decision D1 in docs/decisions.md: published results, scores, outcomes and summaries are readable by
// every app user, while statement text, principal identifiers in findings evidence and the raw readings
// an administrator imported are shown only to direct members of the assessor group. Every other reader
// gets a typed placeholder in the same place. These tests hold every route and export that can carry
// one of those fields to that rule, for an assessor, for a colleague, and for the two readers the
// group check cannot place: a request with no token and one whose identity lookup fails.
//
// The fixtures plant a distinctive string in each restricted field. A route is proved clean by that
// string being absent from the whole body, which also catches a copy of the field somewhere nobody
// thought to look.

import express from 'express';
import type { RequestListener, Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closeServed, servedAt } from './test-servers.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { COMPLETE, observed, type Collector, type SignalId, type SignalResult } from '../collect/signal.js';
import { accountScope } from '../collect/estate-scope.js';
import type { CredentialProvider } from '../collect/credentials.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import type { Evidence, Finding } from '../resolve/finding.js';
import { ScanRunner } from '../scan/runner.js';
import { InMemoryScanStore } from '../scan/store.js';
import type { Scan } from '../scan/scan.js';
import { InMemoryAttestationStore } from '../attest/store.js';
import { InMemoryReviewStore } from '../review/store.js';
import { finalAssessmentProjector } from '../review/projection.js';
import { InMemoryAdvisoryStore } from '../advise/store.js';
import { ADVISORY_SIGNALS, AdvisoryRunner, QUERY_SHAPES, WRITE_PATTERNS } from '../advise/runner.js';
import { InMemoryEvidenceImportStore } from '../import/store.js';
import { envelopeFrom } from '../import/envelope.js';
import { envelope as envelopeFixture } from '../import/envelope-fixture.js';
import { DIGEST_HEADER } from '../export/artefact.js';
import { EXPORT_VARIANTS } from '../export/variant.js';
import { registerApi } from './routes.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();
const ALL_PILLARS = catalogue.pillars.map((pillar) => pillar.id);

const ASSESSORS = 'waf-assessors';

/** The strings planted in restricted fields. None may reach a reader outside the group. */
const SECRET = {
  tokenHolder: 'carol.tokens@example.com',
  tokenCreator: 'svc-0b7e-token-minter',
  runAsUser: 'dana.jobs@example.com',
  adminUser: 'ops.admin@example.com',
  adminReading: 'ADMIN-READING-enableIpAccessLists-is-true',
  statement: 'select ssn from customers_secret_table where id = 7',
  writeStatement: 'insert into payroll_secret_table select * from staging',
} as const;

/** What stays readable to everyone, planted beside the secrets so a test can see it survive. */
const OPEN = {
  headline: '2 of 5 tokens never expire',
  readAs: 'scan-runner@example.com',
};

/** Who SCIM says the caller is, and whether it answers at all. Reset after every test. */
let scimGroups: readonly string[] | undefined = [ASSESSORS];
let scimDown = false;
let scimLookups = 0;

const workspace: RequestListener = (request, response) => {
  if (request.url === '/api/2.0/preview/scim/v2/Me') {
    scimLookups += 1;
    if (scimDown) {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'x-databricks-org-id': '1234567890' });
    response.end(
      JSON.stringify({
        userName: 'reader@example.com',
        ...(scimGroups == null
          ? {}
          : { groups: scimGroups.map((display, at) => ({ display, type: 'direct', value: String(at) })) }),
      })
    );
    return;
  }
  response.writeHead(404).end();
};

const servers: Server[] = [];
afterAll(() => closeServed(servers));
afterEach(() => {
  scimGroups = [ASSESSORS];
  scimDown = false;
});

const asUser: CredentialProvider = {
  mode: 'on-behalf-of-user',
  databricks: () =>
    Promise.resolve({
      mode: 'on-behalf-of-user',
      actor: 'priya@example.com',
      host: 'https://example.cloud.databricks.com',
      token: () => Promise.resolve('t'),
    }),
  cloud: () => Promise.resolve(null),
};

const ESTATE: Partial<Record<SignalId, unknown>> = {
  'sql:uc.census': {
    tableCount: 10,
    catalogCount: 2,
    schemaCount: 3,
    managedTables: 10,
    externalTables: 0,
    views: 0,
    metricViews: 0,
    foreignTables: 0,
    deltaTables: 10,
    icebergTables: 0,
    optimizedFormatTables: 10,
    describedTables: 10,
    distinctOwners: 2,
  },
};

function collector(): Collector {
  return {
    surface: 'sql',
    name: 'synthetic',
    signals: Object.keys(ESTATE) as SignalId[],
    collect: (ids) => Promise.resolve(ids.map((id) => observed(id, ESTATE[id], 1, COMPLETE))),
  };
}

const reading = (over: Partial<Evidence>): Evidence => ({
  signal: 'sql:uc.census',
  observed: '',
  coverage: COMPLETE,
  collectedAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

/** Four kinds of evidence on one finding: two that name a principal, one imported reading, one ordinary. */
function plantedEvidence(): readonly Evidence[] {
  return [
    reading({
      signal: 'rest:workspace:token.list',
      observed: OPEN.headline,
      expected: 'Every personal access token has an expiry',
      provenance: { surface: 'rest', collector: 'tokens', authority: 'on-behalf-of-user', actor: OPEN.readAs },
    }),
    reading({
      signal: 'rest:workspace:token.list',
      bearing: 'detail',
      observed: `Held by: ${SECRET.tokenHolder}, ${SECRET.tokenCreator}`,
    }),
    reading({
      signal: 'sql:jobs.inventory',
      bearing: 'detail',
      observed: `Running as a user account: nightly-etl (${SECRET.runAsUser})`,
      at: {
        lead: 'Running as a user account',
        items: [{ label: 'nightly-etl', note: SECRET.runAsUser, kind: 'job' }],
      },
    }),
    reading({
      signal: 'rest:workspace:preview.workspace-conf',
      observed: SECRET.adminReading,
      expected: 'IP access lists are enabled',
      evidenceClass: 'admin-collected',
      provenance: {
        surface: 'rest',
        collector: 'admin-script:workspace-conf',
        authority: 'admin-cli',
        actor: SECRET.adminUser,
        from: 'https://dbc-0000.cloud.databricks.com',
      },
    }),
  ];
}

function answering(rows: Readonly<Partial<Record<string, unknown>>>): Collector {
  const directory = { workspaces: [{ workspaceId: 'w1', name: 'ws-1', status: 'RUNNING' }], live: [], excluded: [] };
  const values: Record<string, unknown> = { 'sql:estate.workspaces': directory, ...rows };
  return {
    surface: 'sql',
    name: 'advisory',
    signals: [...ADVISORY_SIGNALS],
    collect: (ids): Promise<SignalResult[]> => Promise.resolve(ids.map((id) => observed(id, values[id] ?? [], 0))),
  };
}

const SHAPE = {
  workspaceId: 'w1',
  shape: 'abc0000000000000',
  statementType: 'SELECT',
  kinds: 1,
  runsNow: 500,
  runsBefore: 500,
  measuredNow: 500,
  measuredBefore: 500,
  msNow: 3_600_000,
  msBefore: 1_000_000,
  meanMsNow: 7200,
  meanMsBefore: 2000,
  medianMs: 7200,
  worstMs: 7400,
  spilledBytes: 0,
  shuffleBytes: 0,
  readBytes: 1_000_000,
  writtenBytes: 0,
  readFiles: 10,
  prunedFiles: 90,
  parallelism: 4,
  compilationPercent: 80,
  queueMs: 0,
  cacheHits: 0,
  failures: 0,
  warehouses: 1,
  jobs: 0,
  pipelines: 0,
  coveredMs: 3_000_000,
  excludedMs: 7_000_000,
  coveredRuns: 500,
  excludedRuns: 900,
  statementText: SECRET.statement,
  statementId: 'stmt-1',
  representativeAt: new Date('2026-08-01T00:00:00.000Z'),
};

const WRITE = {
  workspaceId: 'w1',
  shape: 'bbbbbbbbbbbbbbbb',
  statementType: 'INSERT',
  runs: 600,
  finishedRuns: 600,
  daysRun: 14,
  runsStatingBytes: 600,
  writtenBytes: 1_258_291_200,
  medianWriteBytes: 2_097_152,
  largestWriteBytes: 4_194_304,
  readBytes: 0,
  producedRows: 0,
  totalMs: 100,
  statementText: SECRET.writeStatement,
  writeStatements: 600,
  writesStatingBytes: 600,
  estateWrittenBytes: 1_258_291_200,
  otherStatements: 0,
};

interface Seeded {
  readonly base: string;
  readonly runId: string;
  readonly resultId: string;
  readonly reviewId: string;
  readonly advisoryId: string;
  readonly overall: number | undefined;
}

let seeded: Seeded;

const ASSESSOR = { 'x-forwarded-access-token': 'token' };

async function seed(): Promise<Seeded> {
  const workspaceUrl = await servedAt(workspace, servers);

  const scans = new InMemoryScanStore();
  const attestations = new InMemoryAttestationStore();
  const reviews = new InMemoryReviewStore({
    pillars: ALL_PILLARS,
    projection: {
      project: finalAssessmentProjector({ catalogue, registry }),
      scan: (id) => scans.get(id),
      attestation: (id, scope) => attestations.get(id, scope),
    },
  });
  const advisories = new InMemoryAdvisoryStore();
  const imports = new InMemoryEvidenceImportStore();
  const runner = new ScanRunner({ catalogue, registry, store: scans, measuredPillars: ALL_PILLARS, attestations });

  const advised = await new AdvisoryRunner({ store: advisories }).start({
    credentials: asUser,
    scope: accountScope(),
    collectors: [answering({ [QUERY_SHAPES]: [SHAPE], [WRITE_PATTERNS]: [WRITE] })],
    lookbackDays: 30,
  });

  const envelope = envelopeFrom(envelopeFixture());
  await imports.record({
    digest: `sha256:${'c'.repeat(64)}`,
    generatedAt: new Date(envelope.generatedAt),
    importedAt: new Date('2026-08-04T00:00:00Z'),
    importedBy: 'uploader@example.com',
    envelope: { ...envelope, tiers: { ...envelope.tiers, workspace: { ran: true, identity: { username: SECRET.adminUser, host: 'https://dbc-0000.cloud.databricks.com' } } } },
    cautions: [],
  });

  const app = express();
  app.use(express.json());
  registerApi(app, {
    catalogue,
    registry,
    runner,
    store: scans,
    attestations,
    reviews,
    advisories,
    imports,
    host: workspaceUrl,
    assessorGroup: ASSESSORS,
    pillars: ALL_PILLARS,
    collectorsFor: () => [collector()],
  });
  const base = await servedAt(app, servers);

  const started = await fetch(`${base}/api/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ASSESSOR },
    body: '{}',
  });
  const runId = String(((await started.json()) as { id: string }).id);
  const collected = (await scans.get(runId)) as Scan;
  const [first, ...rest] = collected.findings;
  const planted: Finding = { ...(first), evidence: plantedEvidence() };
  const source: Scan = {
    ...collected,
    findings: [planted, ...rest],
    stamp: {
      ...collected.stamp,
      definition: { id: 'definition-sharing', version: 1, fingerprint: 'sha256:definition-sharing', name: 'Sharing' },
    },
  };
  await scans.save(source);
  const scope = '?definitionId=definition-sharing';

  const opened = await fetch(`${base}/api/reviews${scope}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ASSESSOR },
    body: JSON.stringify({ runId }),
  });
  let review = (await opened.json()) as { id: string; result?: { id: string } };
  for (const pillarId of ALL_PILLARS) {
    const skipped = await fetch(`${base}/api/reviews/${review.id}/pillars/${pillarId}/skip${scope}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ASSESSOR },
    });
    review = (await skipped.json()) as typeof review;
  }

  return {
    base,
    runId,
    resultId: String(review.result?.id),
    reviewId: review.id,
    advisoryId: advised.id,
    overall: source.score.overall,
  };
}

beforeAll(async () => {
  seeded = await seed();
}, 60_000);

/** The ways a reader can arrive. The last three are all non-assessors, and must read the same. */
const READERS = {
  assessor: { headers: ASSESSOR, groups: [ASSESSORS], down: false },
  colleague: { headers: ASSESSOR, groups: ['users'], down: false },
  'no token': { headers: {}, groups: [ASSESSORS], down: false },
  'identity lookup failing': { headers: ASSESSOR, groups: [ASSESSORS], down: true },
} as const;
type Reader = keyof typeof READERS;

async function read(path: string, reader: Reader): Promise<{ status: number; text: string; headers: Headers }> {
  const arrived = READERS[reader];
  scimGroups = arrived.groups;
  scimDown = arrived.down;
  const response = await fetch(`${seeded.base}${path}`, { headers: arrived.headers });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

const scope = '?definitionId=definition-sharing';

const EVIDENCE_ROUTES = (): readonly string[] => [
  `/api/scans/latest${scope}`,
  `/api/scans/${seeded.runId}${scope}`,
  `/api/scans/${seeded.runId}/export.json${scope}`,
  `/api/scans/${seeded.runId}/export.csv${scope}`,
  ...EXPORT_VARIANTS.flatMap((variant) => [
    `/api/scans/${seeded.runId}/export.json${scope}&variant=${variant}`,
    `/api/scans/${seeded.runId}/export.csv${scope}&variant=${variant}`,
    `/api/results/${seeded.resultId}/export.json${scope}&variant=${variant}`,
    `/api/results/${seeded.resultId}/export.csv${scope}&variant=${variant}`,
  ]),
  `/api/results/${seeded.resultId}/export.json${scope}`,
  `/api/results/${seeded.resultId}/export.csv${scope}`,
  `/api/results/current${scope}`,
  `/api/results/${seeded.resultId}${scope}`,
  `/api/reviews/for/${seeded.runId}${scope}`,
  `/api/reviews/${seeded.reviewId}${scope}`,
  `/api/reviews${scope}`,
  `/api/scans/${seeded.runId}/changes${scope}`,
  `/api/results/${seeded.resultId}/changes${scope}`,
  `/api/scans/${seeded.runId}/exports${scope}`,
  `/api/results/${seeded.resultId}/exports${scope}`,
];

const PRINCIPALS_AND_READINGS = [
  SECRET.tokenHolder,
  SECRET.tokenCreator,
  SECRET.runAsUser,
  SECRET.adminUser,
  SECRET.adminReading,
];

describe('an assessor reading stored results', () => {
  it.each(['/api/scans/latest', '/api/results/current'])('sees the detail on %s', async (path) => {
    const { status, text } = await read(`${path}${scope}`, 'assessor');

    expect(status).toBe(200);
    for (const secret of PRINCIPALS_AND_READINGS) expect(text).toContain(secret);
    expect(text).not.toContain('"withheld"');
  });

  it('is sent the complete exports, with the detail in them', async () => {
    const json = await read(`/api/scans/${seeded.runId}/export.json${scope}`, 'assessor');
    const csv = await read(`/api/scans/${seeded.runId}/export.csv${scope}`, 'assessor');

    for (const secret of PRINCIPALS_AND_READINGS) expect(json.text).toContain(secret);
    // The sheet carries the observed text of every reading and the attribution of the first only.
    for (const secret of PRINCIPALS_AND_READINGS.filter((one) => one !== SECRET.adminUser)) {
      expect(csv.text).toContain(secret);
    }
  });
});

describe.each(['colleague', 'no token', 'identity lookup failing'] as const)('a reader who is %s', (reader) => {
  it('is served no principal or imported reading on any scan, result or export route', async () => {
    for (const path of EVIDENCE_ROUTES()) {
      const { status, text } = await read(path, reader);

      expect(status, path).toBe(200);
      for (const secret of PRINCIPALS_AND_READINGS) expect(text, `${path} leaked ${secret}`).not.toContain(secret);
    }
  });

  it('still reads the score, the outcome and the open evidence on a scan', async () => {
    const { text } = await read(`/api/scans/${seeded.runId}${scope}`, reader);
    const body = JSON.parse(text) as {
      score: { overall?: number };
      findings: {
        controlId: string;
        outcome: string;
        evidence: { observed: string; expected?: string; withheld?: { withheld: string; visibleTo: string } }[];
      }[];
    };

    expect(body.score.overall).toBe(seeded.overall);
    const planted = body.findings[0];
    expect(planted?.outcome).toBeDefined();
    const open = planted?.evidence.find((one) => one.observed === OPEN.headline);
    expect(open?.expected).toBe('Every personal access token has an expiry');
    expect(open?.withheld).toBeUndefined();
    expect(text).toContain(OPEN.readAs);
  });

  it('is told, in place of each restricted field, what was withheld and who can see it', async () => {
    const { text } = await read(`/api/scans/${seeded.runId}${scope}`, reader);
    const planted = (
      JSON.parse(text) as {
        findings: {
          evidence: {
            signal: string;
            observed: string;
            at?: unknown;
            provenance?: unknown;
            withheld?: { withheld: string; reason: string; visibleTo: string };
          }[];
        }[];
      }
    ).findings[0]?.evidence;

    const withheld = planted?.filter((one) => one.withheld != null) ?? [];
    expect(withheld.map((one) => one.withheld?.withheld).sort()).toEqual([
      'admin-reading',
      'principal-identifiers',
      'principal-identifiers',
    ]);
    for (const one of withheld) {
      expect(one.withheld?.visibleTo).toBe(ASSESSORS);
      expect(one.withheld?.reason).toContain(ASSESSORS);
      expect(one.at).toBeUndefined();
    }
  });

  it('shows the same export file to every non-assessor, and says what it left out', async () => {
    const { text } = await read(`/api/scans/${seeded.runId}/export.csv${scope}`, reader);

    expect(text).toContain(OPEN.headline);
    expect(text).toContain(ASSESSORS);
  });

  it.each(['scans', 'results'] as const)(
    'is shown listed digests that are the digests of the files it downloads from %s',
    async (kind) => {
      const id = kind === 'scans' ? seeded.runId : seeded.resultId;
      const listed = JSON.parse((await read(`/api/${kind}/${id}/exports${scope}`, reader)).text) as {
        variants: { variant: string; files: { name: string; digest: string; href: string; format: string }[] }[];
      };

      expect(listed.variants.length).toBeGreaterThan(0);
      for (const variant of listed.variants) {
        for (const file of variant.files) {
          const downloaded = await read(file.href, reader);
          expect(downloaded.headers.get(DIGEST_HEADER), file.name).toBe(file.digest);
        }
      }
    }
  );

  it('is served no statement text on the advisory routes, and the analysis itself', async () => {
    for (const path of ['/api/advisory/latest', `/api/advisory/${seeded.advisoryId}`]) {
      const { status, text } = await read(path, reader);

      expect(status).toBe(200);
      expect(text).not.toContain(SECRET.statement);
      expect(text).not.toContain(SECRET.writeStatement);
      const body = JSON.parse(text) as {
        workload?: { top: { shape: string; statementWithheld?: { withheld: string; visibleTo: string } }[] };
        writes?: { shapes: { shape: string; statementWithheld?: { withheld: string; visibleTo: string } }[] };
      };
      expect(body.workload?.top[0]?.shape).toBe(SHAPE.shape);
      expect(body.workload?.top[0]?.statementWithheld).toMatchObject({
        withheld: 'statement-text',
        visibleTo: ASSESSORS,
      });
      expect(body.writes?.shapes[0]?.shape).toBe(WRITE.shape);
      expect(body.writes?.shapes[0]?.statementWithheld).toMatchObject({
        withheld: 'statement-text',
        visibleTo: ASSESSORS,
      });
    }
  });

  it('is not shown who collected an imported file', async () => {
    const { status, text } = await read('/api/evidence/imports', reader);
    const body = JSON.parse(text) as { imports: { observed: number; collectedBy?: string; collectedByWithheld?: unknown }[] };

    expect(status).toBe(200);
    expect(text).not.toContain(SECRET.adminUser);
    expect(body.imports).toHaveLength(1);
    expect(body.imports[0]?.observed).toBeGreaterThan(0);
    expect(body.imports[0]?.collectedBy).toBeUndefined();
    expect(body.imports[0]?.collectedByWithheld).toMatchObject({ withheld: 'principal-identifiers' });
  });
});

describe('the digests of what readers download', () => {
  it('differ between an assessor and a colleague only where the file says something was withheld', async () => {
    const list = async (reader: Reader) =>
      (
        JSON.parse((await read(`/api/scans/${seeded.runId}/exports${scope}`, reader)).text) as {
          files: { name: string; digest: string }[];
        }
      ).files;

    const [forAssessor, forColleague] = [await list('assessor'), await list('colleague')];

    expect(forAssessor.map((file) => file.name)).toEqual(forColleague.map((file) => file.name));
    expect(forAssessor.map((file) => file.digest)).not.toEqual(forColleague.map((file) => file.digest));
  });
});

describe('an assessor reading the advisor and the imports', () => {
  it('sees the statement text and who collected the file', async () => {
    const latest = await read('/api/advisory/latest', 'assessor');
    const imports = await read('/api/evidence/imports', 'assessor');

    expect(latest.text).toContain(SECRET.statement);
    expect(latest.text).toContain(SECRET.writeStatement);
    expect(latest.text).not.toContain('statementWithheld');
    expect(imports.text).toContain(SECRET.adminUser);
  });
});

describe('the check on who is reading', () => {
  it('asks the workspace once for a request, and not at all when there is no token to ask with', async () => {
    scimGroups = [ASSESSORS];
    scimDown = false;

    scimLookups = 0;
    await fetch(`${seeded.base}/api/scans/latest`);
    expect(scimLookups).toBe(0);

    scimLookups = 0;
    await fetch(`${seeded.base}/api/scans/latest`, { headers: ASSESSOR });
    expect(scimLookups).toBe(1);
  });
});
