// Serving and changing assessment definitions.
//
// The gate and the failure responder are injected here rather than exercised through `routes.ts`,
// which is what makes these tests about definitions: the real gate needs a SCIM endpoint to answer
// before any assertion about a version could be made, and a test that stood one up would be a test
// of the gate wearing a definition as a costume. The gate itself is tested in `routes.test.ts`.
//
// What is worth holding here is the concurrency behaviour. Two people revising one assessment from
// the same read is the ordinary case for a document several owners look after, and the reflex — last
// write wins — would silently drop one author's change out of a record that exists to be audited.
// Two tests below pin the refusal, one on the version the caller declares and one on the database
// constraint underneath it, because they catch the race at different moments and only the second
// survives two requests arriving at once.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type {
  DefinitionPayload,
  PreflightPayload,
  ScopePreviewPayload,
  SelectableWorkspacesPayload,
  SetupDraftPayload,
  SetupDraftsPayload,
} from '../../shared/api/contract.js';
import { define } from '../define/definition.js';
import type { CheckSources, SignalSources } from '../define/preflight.js';
import { InMemoryDefinitionStore, type DefinitionStore } from '../define/store.js';
import { InMemorySetupDraftStore, type SetupDraftStore } from '../define/setup-store.js';
import { InMemoryScanStore, type ScanStore } from '../scan/store.js';
import type { Scan } from '../scan/scan.js';
import type { EstateSummary } from '../scan/estate.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import type { WorkspaceDirectory } from '../collect/sql/shapes.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { registerDefinitionRoutes } from './definition-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const AT = new Date('2026-08-03T00:00:00Z');

const BODY = {
  measurement: { scope: { kind: 'selected', workspaceIds: ['w2', 'w1'] }, lookbackDays: 30 },
  attribution: { name: 'Q3 platform review', owners: ['alice@example.com'] },
};

class Refused extends Error {}

const SIGNALS: readonly SignalSources[] = [
  { id: 'sql:estate.workspaces', tables: ['system.access.workspaces_latest'] },
  { id: 'sql:cost.attribution', tables: ['system.billing.usage', 'system.access.workspaces_latest'] },
];

const CHECKS: readonly CheckSources[] = [
  {
    controlId: 'CO-01-01',
    pillarId: 'cost-optimization',
    signals: ['sql:cost.attribution', 'sql:estate.workspaces'],
  },
];

const DENIED = 'PERMISSION_DENIED: User does not have SELECT on Table `system.billing.usage`.';

interface Harness {
  readonly base: string;
  readonly definitions: DefinitionStore;
  readonly drafts: SetupDraftStore;
  readonly scans: ScanStore;
  /** What the routes wrote down about the acts, so a test can read it back. */
  readonly audit: AuditLog;
}

async function serve(
  over: {
    readonly definitions?: DefinitionStore | undefined;
    readonly omitStore?: boolean;
    readonly drafts?: SetupDraftStore;
    readonly omitDrafts?: boolean;
    readonly scans?: ScanStore;
    readonly permit?: boolean;
    /** Who the gate says the caller is, so a test can prove a draft belongs to one of them. */
    readonly actor?: string;
    /** Refusals by table name, for the preflight. Absent means no warehouse is bound. */
    readonly refusals?: Readonly<Record<string, string>>;
    readonly checks?: readonly CheckSources[];
    readonly signals?: readonly SignalSources[];
    /** What this build measures, for the unknown-pillar refusal. Absent skips the check. */
    readonly pillars?: readonly string[];
    readonly currentDirectory?: () => Promise<{
      readonly directory?: WorkspaceDirectory;
      readonly asOf: Date;
      readonly unavailable?: string;
    }>;
  } = {}
): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const definitions = over.definitions ?? new InMemoryDefinitionStore();
  const drafts = over.drafts ?? new InMemorySetupDraftStore();
  const scans = over.scans ?? new InMemoryScanStore();
  const audit = new InMemoryAuditLog();
  const recorder = new AuditRecorder(audit);
  let counter = 0;

  registerDefinitionRoutes(app, {
    ...(over.omitStore === true ? {} : { definitions }),
    ...(over.omitDrafts === true ? {} : { drafts }),
    definitionStorage: 'Kept in the waf schema of the bound database.',
    store: scans,
    ...(over.currentDirectory != null ? { currentDirectory: over.currentDirectory } : {}),
    // The real recorder over an in-memory log, rather than a stub act. The routes are the only
    // place the events are composed, so a fake `act` here would leave nothing checking that a
    // revision records the definition it revised.
    permitted: (
      _request: Request,
      response: Response,
      action: AuditAction,
      context?: { readonly target?: AuditTarget }
    ) =>
      over.permit === false
        ? Promise.reject(new Refused('not permitted'))
        : Promise.resolve({
            actor: over.actor ?? 'alice@example.com',
            // Netted the way `routes.ts` nets it, from the same function, and handed the same context,
            // so a route that returns early is held here to recording something — and to recording
            // what it was acting on — rather than only in production.
            act: closedWhenAnswered(
              recorder.begin(
                action,
                { actor: over.actor ?? 'alice@example.com', executionMode: 'on-behalf-of-user' },
                context ?? {}
              ),
              response
            ),
          }),
    respondToFailure: (response: Response, cause: unknown) => {
      if (cause instanceof Refused) {
        response.status(403).json({ error: 'not-permitted', message: cause.message });
        return;
      }
      response.status(500).json({ error: 'unexpected', message: String(cause) });
    },
    now: () => AT,
    ...(over.pillars != null ? { pillars: over.pillars } : {}),
    // Deterministic, so a test can name the definition it just created.
    newId: () => `d${String(++counter)}`,
    ...(over.refusals != null
      ? {
          probeFor: () => (table: string) => {
            const message = over.refusals?.[table];
            return message != null ? Promise.reject(new Error(message)) : Promise.resolve();
          },
          sources: () => ({ checks: over.checks ?? CHECKS, signals: over.signals ?? SIGNALS }),
        }
      : {}),
  });

  const base = await servedAt(app, servers);
  return { base, definitions, drafts, scans, audit };
}

/**
 * Releases its waiters only once enough of them have arrived.
 *
 * Needed because the race this suite has to reproduce cannot happen by itself: two requests to one
 * Node process are served one after the other, so a handler that reads and then writes is never
 * interrupted between the two. Armed after setup, so the requests that build the fixture are not
 * counted as waiters.
 */
class Barrier {
  private armed = false;
  private waiting: (() => void)[] = [];

  constructor(private readonly width: number) {}

  arm(): void {
    this.armed = true;
  }

  reached(): Promise<void> {
    if (!this.armed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      if (this.waiting.length < this.width) return;
      const released = this.waiting;
      this.waiting = [];
      for (const release of released) release();
    });
  }
}

/**
 * A whole scan, of which these routes read two fields.
 *
 * Built in full rather than cast from the two that matter. A cast would compile today and stop
 * compiling nothing tomorrow: the point of the type is that a route reading `estate` is reading
 * something a scan really has, and a fixture that asserts its way past that proves the route works
 * against a shape no scan ever takes.
 */
function scanWith(estate: EstateSummary): Scan {
  return {
    id: 'latest',
    startedAt: AT,
    finishedAt: new Date(AT.getTime() + 60_000),
    state: 'complete',
    stamp: {
      catalogueVersion: '9',
      catalogueFingerprint: 'sha256:abc',
      executionMode: 'on-behalf-of-user',
      actor: 'alice@example.com',
      scope: { description: 'the account' },
      lookbackDays: 30,
    },
    score: {
      pillars: [],
      counts: { pass: 0, fail: 0, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
      scoredControls: 0,
      composition: { observed: 0, 'admin-collected': 0, attested: 0 },
      totalControls: 0,
      overall: 0,
    },
    findings: [],
    signals: [],
    estate,
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
  };
}

function post(base: string, path: string, body: unknown): Promise<globalThis.Response> {
  return send('POST', base, path, body);
}

function put(base: string, path: string, body: unknown): Promise<globalThis.Response> {
  return send('PUT', base, path, body);
}

/** One definition, through the route, so a test about revising it starts from a real version 1. */
async function created(base: string): Promise<DefinitionPayload> {
  return (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;
}

function send(method: string, base: string, path: string, body: unknown): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('creating a definition', () => {
  it('stores it at version 1 and answers with the canonical form', async () => {
    const { base, definitions } = await serve();

    const response = await post(base, '/api/definitions', BODY);
    expect(response.status).toBe(201);

    const payload = (await response.json()) as DefinitionPayload;
    expect(payload.versions).toHaveLength(1);
    expect(payload.versions[0]?.createdBy).toBe('alice@example.com');
    // Sorted on the way in, so the payload shows what was stored rather than what was sent.
    expect(payload.versions[0]?.measurement.scope.workspaceIds).toEqual(['w1', 'w2']);
    expect(await definitions.get(payload.id)).toBeDefined();
  });

  it('refuses before reading the body when the caller may not change anything', async () => {
    const { base, definitions } = await serve({ permit: false });

    const response = await post(base, '/api/definitions', BODY);

    expect(response.status).toBe(403);
    expect(await definitions.all()).toEqual([]);
  });

  /*
   * Nothing is filled in on the caller's behalf. A missing lookback defaulted to ninety days would
   * put a number nobody chose into the fingerprint every run is compared on.
   */
  it('refuses a body that leaves the measurement to the app', async () => {
    const { base } = await serve();

    const noLookback = await post(base, '/api/definitions', { ...BODY, measurement: { scope: { kind: 'account' } } });
    expect(noLookback.status).toBe(400);
    expect(((await noLookback.json()) as { message: string }).message).toContain('how far back');

    const noScope = await post(base, '/api/definitions', { ...BODY, measurement: { lookbackDays: 30 } });
    expect(noScope.status).toBe(400);

    const badScope = await post(base, '/api/definitions', {
      ...BODY,
      measurement: { scope: { kind: 'everything' }, lookbackDays: 30 },
    });
    expect(badScope.status).toBe(400);

    const noName = await post(base, '/api/definitions', { ...BODY, attribution: { owners: [] } });
    expect(noName.status).toBe(400);
  });

  it('passes the domain’s own refusal through with its reason', async () => {
    const { base } = await serve();

    const response = await post(base, '/api/definitions', {
      ...BODY,
      measurement: { scope: { kind: 'selected', workspaceIds: [] }, lookbackDays: 30 },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain('at least one');
  });

  /*
   * A scan request naming an unknown pillar is already refused, and the argument is stronger for a
   * definition: a scan request is one run, while a definition repeats its mistake on every run at a
   * stable fingerprint — so the trend reads as healthy while the pillar the author asked about is
   * measured by nothing.
   */
  it('refuses a pillar this build does not measure, on creation and on revision', async () => {
    const { base } = await serve({ pillars: ['security', 'cost'] });

    const created = await post(base, '/api/definitions', {
      ...BODY,
      measurement: { scope: { kind: 'account' }, lookbackDays: 30, pillars: ['security', 'securty'] },
    });
    expect(created.status).toBe(400);
    const said = ((await created.json()) as { message: string }).message;
    expect(said).toContain('securty');
    expect(said).toContain('security, cost');

    const good = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;
    const revised = await post(base, `/api/definitions/${good.id}/versions`, {
      fromVersion: 1,
      measurement: { scope: { kind: 'account' }, lookbackDays: 30, pillars: ['reliablity'] },
      note: 'narrowing to one pillar',
    });
    expect(revised.status).toBe(400);
    expect(((await revised.json()) as { message: string }).message).toContain('reliablity');
  });

  it('accepts the pillars this build does measure', async () => {
    const { base } = await serve({ pillars: ['security', 'cost'] });

    const response = await post(base, '/api/definitions', {
      ...BODY,
      measurement: { scope: { kind: 'account' }, lookbackDays: 30, pillars: ['cost', 'security'] },
    });

    expect(response.status).toBe(201);
    const payload = (await response.json()) as DefinitionPayload;
    expect(payload.versions[0]?.measurement.pillars).toEqual(['cost', 'security']);
  });
});

describe('revising a definition', () => {
  it('appends a version and keeps the one before it', async () => {
    const { base } = await serve();
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;

    const response = await post(base, `/api/definitions/${created.id}/versions`, {
      fromVersion: 1,
      attribution: { name: 'Q3 platform review (EMEA)', owners: ['alice@example.com'] },
      note: 'Scope unchanged, name clarified',
    });

    expect(response.status).toBe(201);
    const payload = (await response.json()) as DefinitionPayload;
    expect(payload.versions.map((one) => one.version)).toEqual([1, 2]);
    expect(payload.versions[1]?.note).toBe('Scope unchanged, name clarified');
    // The property the fingerprint split exists for, visible on the wire: a rename does not change
    // what the run is comparable to, and the browser can see that without recomputing a hash.
    expect(payload.versions[1]?.fingerprint).toBe(payload.versions[0]?.fingerprint);
  });

  it('changes the fingerprint when the estate changed', async () => {
    const { base } = await serve();
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;

    const response = await post(base, `/api/definitions/${created.id}/versions`, {
      fromVersion: 1,
      measurement: { scope: { kind: 'selected', workspaceIds: ['w1', 'w2', 'w3'] }, lookbackDays: 30 },
    });

    const payload = (await response.json()) as DefinitionPayload;
    expect(payload.versions[1]?.fingerprint).not.toBe(payload.versions[0]?.fingerprint);
  });

  /*
   * The declared version is the concurrency control, and this is the case it catches: the second
   * author's request arrives after the first landed, so the app can name who changed it.
   */
  it('refuses a revision made against a version somebody has already replaced', async () => {
    const { base } = await serve();
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;

    await post(base, `/api/definitions/${created.id}/versions`, {
      fromVersion: 1,
      attribution: { name: 'Mine', owners: [] },
    });
    const late = await post(base, `/api/definitions/${created.id}/versions`, {
      fromVersion: 1,
      attribution: { name: 'Theirs', owners: [] },
    });

    expect(late.status).toBe(409);
    const body = (await late.json()) as { error: string; message: string; currentVersion: number };
    expect(body.error).toBe('stale-definition');
    expect(body.currentVersion).toBe(2);
    // Names who, because the next thing the author does is go and ask them.
    expect(body.message).toContain('alice@example.com');

    // And the winner's revision stands, which is the half a last-write-wins would have lost.
    const read = (await (await fetch(`${base}/api/definitions`)).json()) as { definitions: DefinitionPayload[] };
    expect(read.definitions[0]?.versions.at(-1)?.attribution.name).toBe('Mine');
  });

  /*
   * The same race one moment earlier, and the reason the store has a constraint of its own.
   *
   * Above, the second request arrived after the first had landed, so the version it declared was
   * visibly stale and the route caught it. Here both requests read version 1 before either wrote, so
   * both declarations were true when they were made and the route has nothing to compare against.
   * Only the store's key refuses this one.
   *
   * The interleaving is forced rather than hoped for. Two `fetch` calls in a `Promise.all` run to
   * completion one after the other on a single event loop, which is why the first version of this
   * test passed while exercising the route's check instead of the store's — the assertion on the
   * message below is what keeps it honest about which of the two refused.
   */
  it('refuses the loser of a race that both callers were entitled to start', async () => {
    const definitions = new InMemoryDefinitionStore();
    // Holds every reader until two have arrived, so both handlers see version 1 as current.
    const readers = new Barrier(2);
    const gated: DefinitionStore = {
      durable: definitions.durable,
      all: () => definitions.all(),
      create: (definition) => definitions.create(definition),
      appendVersion: (id, version) => definitions.appendVersion(id, version),
      archive: (id, at) => definitions.archive(id, at),
      unarchive: (id) => definitions.unarchive(id),
      get: async (id) => {
        const found = await definitions.get(id);
        await readers.reached();
        return found;
      },
    };

    const { base } = await serve({ definitions: gated });
    // Created before the barrier can matter, since creating reads nothing.
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;
    readers.arm();

    const [first, second] = await Promise.all([
      post(base, `/api/definitions/${created.id}/versions`, {
        fromVersion: 1,
        attribution: { name: 'Mine', owners: [] },
      }),
      post(base, `/api/definitions/${created.id}/versions`, {
        fromVersion: 1,
        attribution: { name: 'Theirs', owners: [] },
      }),
    ]);

    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([201, 409]);

    const loser = first.status === 409 ? first : second;
    const body = (await loser.json()) as { error: string; message: string };
    expect(body.error).toBe('stale-definition');
    // The store's sentence, not the route's. If this ever reads "is now current" again, the
    // interleaving stopped happening and the test went back to proving something else.
    expect(body.message).toContain('already exists');

    // Exactly two versions, so the loser appended nothing on top of the winner.
    const stored = await definitions.get(created.id);
    expect(stored?.versions.map((one) => one.version)).toEqual([1, 2]);
    expect(stored?.versions).toHaveLength(2);
  });

  it('refuses a revision that declares no version at all', async () => {
    const { base } = await serve();
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;

    const response = await post(base, `/api/definitions/${created.id}/versions`, {
      attribution: { name: 'Renamed', owners: [] },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain('which version it was made from');
  });

  it('answers 404 for an assessment that does not exist', async () => {
    const { base } = await serve();

    const response = await post(base, '/api/definitions/nope/versions', { fromVersion: 1, note: 'x' });

    expect(response.status).toBe(404);
  });

  it('refuses a revision that would change nothing', async () => {
    const { base } = await serve();
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;

    const response = await post(base, `/api/definitions/${created.id}/versions`, {
      fromVersion: 1,
      // The same measurement written in a different order, which is the same claim.
      measurement: { scope: { kind: 'selected', workspaceIds: ['w2', 'w1'] }, lookbackDays: 30 },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain('change nothing');
  });
});

describe('archiving a definition', () => {
  it('closes it to new runs without removing it or its versions', async () => {
    const { base } = await serve();
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;

    const response = await post(base, `/api/definitions/${created.id}/archive`, {});

    expect(response.status).toBe(200);
    const payload = (await response.json()) as DefinitionPayload;
    expect(payload.archivedAt).toBe(AT.toISOString());
    expect(payload.versions).toHaveLength(1);

    // Still listed, because finding last quarter's assessment is exactly why it was kept.
    const read = (await (await fetch(`${base}/api/definitions`)).json()) as { definitions: DefinitionPayload[] };
    expect(read.definitions).toHaveLength(1);
  });
});

describe('putting an archived definition back', () => {
  it('reopens it to new runs, and the versions were never touched', async () => {
    const { base } = await serve();
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;
    await post(base, `/api/definitions/${created.id}/archive`, {});

    const response = await post(base, `/api/definitions/${created.id}/unarchive`, {});

    expect(response.status).toBe(200);
    const payload = (await response.json()) as DefinitionPayload;
    expect(payload.archivedAt).toBeUndefined();
    expect(payload.versions).toHaveLength(1);
  });

  it('leaves nothing behind that still reads as archived', async () => {
    // The bug this is here for: clearing the state in the response while the store keeps the date, so
    // the row reopens until the page is reloaded. Read back through a second request, not the body of
    // the first.
    const { base } = await serve();
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;
    await post(base, `/api/definitions/${created.id}/archive`, {});
    await post(base, `/api/definitions/${created.id}/unarchive`, {});

    const read = (await (await fetch(`${base}/api/definitions`)).json()) as { definitions: DefinitionPayload[] };
    expect(read.definitions[0]?.archivedAt).toBeUndefined();
  });

  // That a reopened assessment can actually be run again is asserted in `routes.test.ts`, beside the
  // refusal it lifts — this harness mounts the definition routes only, so `/api/scans` is not here.

  it('succeeds on one that was never archived, rather than refusing a state the caller wants', async () => {
    const { base } = await serve();
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;

    const response = await post(base, `/api/definitions/${created.id}/unarchive`, {});

    expect(response.status).toBe(200);
    expect(((await response.json()) as DefinitionPayload).archivedAt).toBeUndefined();
  });

  it('refuses an id it does not know', async () => {
    const { base } = await serve();

    const response = await post(base, '/api/definitions/nope/unarchive', {});

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('unknown-definition');
  });

  it('says nothing is kept here rather than pretending it worked', async () => {
    const { base } = await serve({ omitStore: true });

    const response = await post(base, '/api/definitions/anything/unarchive', {});

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe('definitions-unavailable');
  });
});

describe('an install that keeps nothing', () => {
  it('lists an empty set and says why, rather than failing the page', async () => {
    const { base } = await serve({ omitStore: true });

    const response = await fetch(`${base}/api/definitions`);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { definitions: unknown[]; durable: boolean; storage: string };
    expect(payload.definitions).toEqual([]);
    expect(payload.durable).toBe(false);
    expect(payload.storage).toContain('Bind a database');
  });

  it('refuses to accept a definition it would lose', async () => {
    const { base } = await serve({ omitStore: true });

    const response = await post(base, '/api/definitions', BODY);

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe('definitions-unavailable');
  });
});

describe('the workspaces a definition can name', () => {
  it('says an assessable workspace is assessable and a stopped one is not', async () => {
    const scans = new InMemoryScanStore();
    await scans.save(
      scanWith({
        assessed: [{ id: 'w1', name: 'Analytics', status: 'RUNNING', url: 'https://one' }],
        excluded: [
          { id: 'w9', name: 'Retired', status: 'BANNED', reason: 'not-running' },
          { id: 'w8', name: 'Elsewhere', status: 'RUNNING', reason: 'other-region' },
        ],
      })
    );
    const { base } = await serve({ scans });

    const payload = (await (await fetch(`${base}/api/workspaces`)).json()) as SelectableWorkspacesPayload;

    expect(payload.asOf).toBe(AT.toISOString());
    expect(payload.workspaces.map((one) => one.name)).toEqual(['Analytics', 'Elsewhere', 'Retired']);
    expect(payload.workspaces.find((one) => one.id === 'w1')?.assessable).toBe(true);
    // The case a status alone cannot explain: RUNNING, and still not something this deployment
    // could cover, so offering it as selectable would promise an assessment it cannot deliver.
    const elsewhere = payload.workspaces.find((one) => one.id === 'w8');
    expect(elsewhere?.status).toBe('RUNNING');
    expect(elsewhere?.assessable).toBe(false);
    expect(elsewhere?.reason).toBe('other-region');
  });

  /*
   * The last run was narrowed and the next definition need not be. Being outside one assessment's scope
   * is a fact about that assessment, not about the workspace, so these stay selectable — otherwise the
   * first narrowed run makes the estate permanently unwidenable from the picker that defines it.
   */
  it('still offers a workspace the last run was not asked about', async () => {
    const scans = new InMemoryScanStore();
    await scans.save(
      scanWith({
        assessed: [{ id: 'w1', name: 'Analytics', status: 'RUNNING' }],
        excluded: [],
        outOfScope: [{ id: 'w2', name: 'Platform', status: 'RUNNING' }],
      })
    );
    const { base } = await serve({ scans });

    const payload = (await (await fetch(`${base}/api/workspaces`)).json()) as SelectableWorkspacesPayload;

    expect(payload.workspaces.map((one) => one.id)).toEqual(['w1', 'w2']);
    expect(payload.workspaces.find((one) => one.id === 'w2')?.assessable).toBe(true);
    expect(payload.workspaces.find((one) => one.id === 'w2')?.reason).toBeUndefined();
  });

  it('says no scan has run rather than offering an empty estate', async () => {
    const { base } = await serve();

    const payload = (await (await fetch(`${base}/api/workspaces`)).json()) as SelectableWorkspacesPayload;

    expect(payload.workspaces).toEqual([]);
    expect(payload.unavailable).toContain('No scan has run yet');
    expect(payload.asOf).toBeUndefined();
  });

  it('reads the directory without starting a scan on a fresh install', async () => {
    const asOf = new Date('2026-08-27T01:02:03.000Z');
    const { base } = await serve({
      currentDirectory: () =>
        Promise.resolve({
          asOf,
          directory: {
            workspaces: [
              { workspaceId: 'w2', name: 'Platform', status: 'RUNNING', live: true },
              { workspaceId: 'w1', name: 'Analytics', status: 'RUNNING', live: true },
              { workspaceId: 'w9', name: 'Retired', status: 'BANNED', live: false },
            ],
            live: [
              { workspaceId: 'w2', name: 'Platform', status: 'RUNNING', live: true },
              { workspaceId: 'w1', name: 'Analytics', status: 'RUNNING', live: true },
            ],
            excluded: [
              {
                workspaceId: 'w9',
                name: 'Retired',
                status: 'BANNED',
                live: false,
                reason: 'not-running',
              },
            ],
            regionUnverified: [],
            outOfScope: [],
          },
        }),
    });

    const payload = (await (await fetch(`${base}/api/workspaces`)).json()) as SelectableWorkspacesPayload;

    expect(payload.asOf).toBe(asOf.toISOString());
    expect(payload.workspaces.map((workspace) => workspace.name)).toEqual(['Analytics', 'Platform', 'Retired']);
    expect(payload.workspaces.find((workspace) => workspace.id === 'w9')).toMatchObject({
      assessable: false,
      reason: 'not-running',
    });
  });

  /*
   * An unreadable directory is not an empty account. A picker that showed nothing without saying so
   * would let an author conclude the estate has no workspaces, when what happened is that the
   * scanning identity could not read the table.
   */
  it('passes on the collector’s reason when the estate could not be determined', async () => {
    const scans = new InMemoryScanStore();
    await scans.save(
      scanWith({
        assessed: [],
        excluded: [],
        undeterminedReason: 'The workspace directory needs SELECT on system.access.workspaces_latest.',
      })
    );
    const { base } = await serve({ scans });

    const payload = (await (await fetch(`${base}/api/workspaces`)).json()) as SelectableWorkspacesPayload;

    expect(payload.workspaces).toEqual([]);
    expect(payload.unavailable).toContain('system.access.workspaces_latest');
    // Dated, because the reader needs to know when that was true.
    expect(payload.asOf).toBe(AT.toISOString());
  });
});

/*
 * The preflight is the one route here that spends the caller's authority on the customer's
 * warehouse, so two things matter beyond the arithmetic: it is gated like a mutation even though it
 * changes nothing, and the grant it names has to be the one that would actually work.
 */
describe('checking a definition before it runs', () => {
  async function definition(base: string): Promise<string> {
    const created = (await (await post(base, '/api/definitions', BODY)).json()) as DefinitionPayload;
    return created.id;
  }

  it('names the grant, the identity and the checks it would unblock', async () => {
    const { base } = await serve({ refusals: { 'system.billing.usage': DENIED } });
    const id = await definition(base);

    const response = await post(base, `/api/definitions/${id}/preflight`, {});
    expect(response.status).toBe(200);

    const payload = (await response.json()) as PreflightPayload;
    expect(payload.ranAs).toBe('alice@example.com');
    expect(payload.version).toBe(1);
    expect(payload.ready).toBe(0);

    const usage = payload.sources.find((source) => source.table === 'system.billing.usage');
    expect(usage?.reading).toBe('denied');
    expect(usage?.grant).toBe('GRANT SELECT ON SCHEMA system.billing TO `alice@example.com`');
    expect(usage?.blocks).toEqual(['CO-01-01']);
    expect(payload.blocked).toEqual([{ controlId: 'CO-01-01', pillarId: 'cost-optimization', needs: [usage?.grant] }]);
  });

  it('reports everything ready when nothing refuses', async () => {
    const { base } = await serve({ refusals: {} });
    const id = await definition(base);

    const payload = (await (await post(base, `/api/definitions/${id}/preflight`, {})).json()) as PreflightPayload;

    expect(payload.blocked).toEqual([]);
    expect(payload.ready).toBe(1);
    expect(payload.sources.every((source) => source.reading === 'readable')).toBe(true);
  });

  /*
   * Spending the caller's warehouse authority is not a read of this app. A viewer who could trigger
   * twenty-eight statements against a customer's warehouse has been given the expensive half of a
   * scan without the gate that guards the scan.
   */
  it('is gated like a change, although it changes nothing', async () => {
    const definitions = new InMemoryDefinitionStore();
    await definitions.create(
      define(
        { measurement: { scope: { kind: 'account' }, lookbackDays: 30 }, attribution: { name: 'Q3', owners: [] } },
        'd9',
        AT,
        'alice@example.com'
      )
    );
    const closed = await serve({ definitions, refusals: {}, permit: false });

    const response = await post(closed.base, '/api/definitions/d9/preflight', {});

    expect(response.status).toBe(403);
  });

  it('says why it cannot check rather than reporting every source readable', async () => {
    const { base } = await serve();
    const id = await definition(base);

    const response = await post(base, `/api/definitions/${id}/preflight`, {});

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe('preflight-unavailable');
  });

  it('answers 404 for an assessment that is not there', async () => {
    const { base } = await serve({ refusals: {} });

    const response = await post(base, '/api/definitions/nope/preflight', {});

    expect(response.status).toBe(404);
  });

  /*
   * The two halves have different freshness, and the payload has to say so. Grants were checked in
   * this request; the scope was resolved against whatever directory the last scan read, which may be
   * a month old — and a reader told only "checked just now" would act on the older half believing it.
   */
  it('dates the scope separately from the probe, since only one of them is live', async () => {
    const scans = new InMemoryScanStore();
    await scans.save(
      scanWith({
        assessed: [{ id: 'w1', name: 'Analytics', status: 'RUNNING' }],
        excluded: [{ id: 'w2', name: 'Retired', status: 'BANNED', reason: 'not-running' }],
      })
    );
    const { base } = await serve({ scans, refusals: {} });
    const id = await definition(base);

    const payload = (await (await post(base, `/api/definitions/${id}/preflight`, {})).json()) as PreflightPayload;

    expect(payload.scopeAsOf).toBe(AT.toISOString());
    expect(payload.ranAt).toBe(AT.toISOString());
    // BODY names w1 and w2. One is live, the other stopped, so the assessment covers less than it says.
    expect(payload.scope?.assessed).toEqual(['w1']);
    expect(payload.scope?.omitted).toEqual([{ workspaceId: 'w2', name: 'Retired', reason: 'not-running' }]);
    expect(payload.scope?.complete).toBe(false);
  });

  it('leaves the scope out when no scan has read a directory to resolve it against', async () => {
    const { base } = await serve({ refusals: {} });
    const id = await definition(base);

    const payload = (await (await post(base, `/api/definitions/${id}/preflight`, {})).json()) as PreflightPayload;

    // The resolution exists and says why it is undetermined; the payload's scope does not, because every
    // field of it is a set of workspaces and three empty ones would draw an estate of nothing. The reason
    // reaches the reader as a sentence instead.
    expect(payload.scope).toBeUndefined();
    expect(payload.scopeAsOf).toBeUndefined();
    expect(payload.verdict).toContain('not known yet');
    expect(payload.verdict).toContain('No scan has read the account directory');
  });

  /*
   * A scan that ran and was refused the directory is not the same situation as no scan having run, and
   * the two want opposite actions from the reader: run one, or fix a grant. The collector already wrote
   * the sentence that names the grant, so the verdict carries it rather than sending the author back to
   * re-run a scan that would be refused the same way.
   */
  it('names the grant the last scan was refused rather than asking for a scan that has already run', async () => {
    const scans = new InMemoryScanStore();
    await scans.save(
      scanWith({
        assessed: [],
        excluded: [],
        undeterminedReason: 'The workspace directory needs SELECT on system.access.workspaces_latest.',
      })
    );
    const { base } = await serve({ scans, refusals: {} });
    const id = await definition(base);

    const payload = (await (await post(base, `/api/definitions/${id}/preflight`, {})).json()) as PreflightPayload;

    expect(payload.scope).toBeUndefined();
    expect(payload.verdict).toContain('system.access.workspaces_latest');
    expect(payload.verdict).not.toContain('No scan has read the account directory');
  });
});

describe('presenting a definition', () => {
  it('omits what was never set rather than sending nulls the browser has to test for', async () => {
    const { base, definitions } = await serve();
    await definitions.create(
      define(
        {
          measurement: { scope: { kind: 'account' }, lookbackDays: 90 },
          attribution: { name: 'Whole estate', owners: [] },
        },
        'd-account',
        AT,
        'alice@example.com'
      )
    );

    const read = (await (await fetch(`${base}/api/definitions`)).json()) as { definitions: DefinitionPayload[] };
    const version = read.definitions[0]?.versions[0];

    expect(version?.measurement.scope).toEqual({ kind: 'account' });
    expect(version?.measurement.pillars).toBeUndefined();
    expect(version?.attribution.purpose).toBeUndefined();
    expect(version?.note).toBeUndefined();
    expect(read.definitions[0]?.archivedAt).toBeUndefined();
  });
});

/*
 * An assessment part-written.
 *
 * The tests worth having here are not about round-tripping fields — the store tests cover that.
 * They are about the two ways the surface could hand something to the wrong person and the one way
 * it could tell them the wrong thing. The author comes from the gate and never from the body, so a
 * caller cannot write into a colleague's list or read out of it. And a revision whose assessment
 * moved on while the draft sat has to say so on the way in, because the alternative is a 409 after
 * the author has re-read five steps.
 */
describe('keeping an assessment part-written', () => {
  const HALF = { name: 'Q3 platform review', scope: { kind: 'account' } };

  it('keeps a half-written one and says what is still missing', async () => {
    const { base } = await serve();

    const response = await put(base, '/api/definitions/drafts', HALF);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as SetupDraftPayload;
    expect(payload.name).toBe('Q3 platform review');
    expect(payload.ready).toBe(false);
    expect(payload.troubles.map((one) => one.trouble.toLowerCase())).toContainEqual(
      expect.stringContaining('how far back')
    );
    // Where the author is put back, derived rather than stored, so a second browser agrees.
    expect(payload.resumeAt).toBe('scope');
    expect(payload.standing).toBe('new');
  });

  it('a second save replaces the first rather than leaving two to choose between', async () => {
    const { base } = await serve();

    await put(base, '/api/definitions/drafts', HALF);
    await put(base, '/api/definitions/drafts', { ...HALF, name: 'Renamed', lookbackDays: 30 });

    const listed = (await (await fetch(`${base}/api/definitions/drafts`)).json()) as SetupDraftsPayload;
    expect(listed.drafts).toHaveLength(1);
    expect(listed.drafts[0]?.name).toBe('Renamed');
    expect(listed.drafts[0]?.ready).toBe(true);
    expect(listed.drafts[0]?.resumeAt).toBe('confirm');
  });

  // A draft is keyed on `definitionId ?? ''`, so an empty id is the key of the new-assessment draft.
  // A revision carrying one landed on top of whatever new assessment the author had part-written and
  // replaced it, reporting success — the author came back to find their work gone and a revision of
  // nothing in its place.
  it('refuses a blank revision id rather than overwriting a new assessment in progress', async () => {
    const { base } = await serve();

    await put(base, '/api/definitions/drafts', { ...HALF, lookbackDays: 30 });
    const response = await put(base, '/api/definitions/drafts', {
      name: 'A revision of nothing',
      definitionId: '',
      fromVersion: 1,
    });
    expect(response.status).toBe(400);

    // The part-written one is still there, and is still the one it was.
    const listed = (await (await fetch(`${base}/api/definitions/drafts`)).json()) as SetupDraftsPayload;
    expect(listed.drafts).toHaveLength(1);
    expect(listed.drafts[0]?.name).toBe('Q3 platform review');
  });

  it('lists only the caller’s own, whoever the body claims to be', async () => {
    const drafts = new InMemorySetupDraftStore();
    const asAlice = await serve({ drafts, actor: 'alice@example.com' });
    const asBob = await serve({ drafts, actor: 'bob@example.com' });

    await put(asAlice.base, '/api/definitions/drafts', { ...HALF, author: 'bob@example.com' });

    expect(((await (await fetch(`${asBob.base}/api/definitions/drafts`)).json()) as SetupDraftsPayload).drafts).toEqual(
      []
    );
    expect(
      ((await (await fetch(`${asAlice.base}/api/definitions/drafts`)).json()) as SetupDraftsPayload).drafts
    ).toHaveLength(1);
  });

  it('refuses a caller who may not change anything, on the read as well as the write', async () => {
    const { base } = await serve({ permit: false });

    expect((await put(base, '/api/definitions/drafts', HALF)).status).toBe(403);
    expect((await fetch(`${base}/api/definitions/drafts`)).status).toBe(403);
  });

  it('discards one and leaves the caller’s others alone', async () => {
    const { base, drafts } = await serve();
    const { id } = await created(base);

    await put(base, '/api/definitions/drafts', HALF);
    await put(base, '/api/definitions/drafts', { ...HALF, definitionId: id, fromVersion: 1 });

    const discarded = await fetch(`${base}/api/definitions/drafts`, { method: 'DELETE' });
    expect(discarded.status).toBe(204);

    expect(await drafts.get('alice@example.com')).toBeUndefined();
    expect(await drafts.get('alice@example.com', id)).toBeDefined();
  });

  /*
   * The reason `standingOf` exists. The revision routes already refuse this with a 409 — but only
   * after the author has pressed the last button, having re-read a scope they are about to be told
   * is out of date.
   */
  it('warns on the way in that somebody else has revised the assessment since', async () => {
    const { base } = await serve();
    const { id } = await created(base);
    await put(base, '/api/definitions/drafts', { ...HALF, definitionId: id, fromVersion: 1 });

    await post(base, `/api/definitions/${id}/versions`, {
      fromVersion: 1,
      attribution: { name: 'Renamed by somebody', owners: [] },
    });

    // The revision above discarded the draft, being a completed one — so it is written again, which
    // is what an author would have done in another tab.
    await put(base, '/api/definitions/drafts', { ...HALF, definitionId: id, fromVersion: 1 });

    const listed = (await (await fetch(`${base}/api/definitions/drafts`)).json()) as SetupDraftsPayload;
    expect(listed.drafts[0]?.standing).toBe('superseded');
    expect(listed.drafts[0]?.warning).toContain('version 2 is now current');
    // Named, so a resume list reads as more than a list of ids.
    expect(listed.drafts[0]?.definitionName).toBe('Renamed by somebody');
  });

  it('refuses a revision draft that cannot say which version it came from', async () => {
    const { base } = await serve();

    const response = await put(base, '/api/definitions/drafts', { ...HALF, definitionId: 'd1' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain('which version');
  });

  /*
   * A lookback of "thirty" stored would reach `troubles`, which asks whether it is an integer, and
   * the author would be told a number they never typed was out of range.
   */
  it('refuses a field of the wrong shape rather than keeping it', async () => {
    const { base } = await serve();

    expect((await put(base, '/api/definitions/drafts', { ...HALF, lookbackDays: 'thirty' })).status).toBe(400);
    expect((await put(base, '/api/definitions/drafts', { ...HALF, owners: [7] })).status).toBe(400);
    expect((await put(base, '/api/definitions/drafts', { ...HALF, scope: { kind: 'everything' } })).status).toBe(400);
  });

  /*
   * Half-way through choosing workspaces is a legitimate place to be, and the two wrong answers are
   * refusing to remember it and quietly widening it back to the whole account.
   */
  it('keeps a scope that has been narrowed but not yet filled in', async () => {
    const { base } = await serve();

    const payload = (await (
      await put(base, '/api/definitions/drafts', { ...HALF, scope: { kind: 'selected' }, lookbackDays: 30 })
    ).json()) as SetupDraftPayload;

    expect(payload.scope?.kind).toBe('selected');
    expect(payload.ready).toBe(false);
    expect(payload.resumeAt).toBe('scope');
  });

  it('says plainly that an install with nowhere to keep one will lose it', async () => {
    const { base } = await serve({ omitDrafts: true });

    const listed = (await (await fetch(`${base}/api/definitions/drafts`)).json()) as SetupDraftsPayload;
    expect(listed.durable).toBe(false);
    expect(listed.storage).toContain('loses what you have written');

    expect((await put(base, '/api/definitions/drafts', HALF)).status).toBe(503);
  });
});

/*
 * The draft goes away when the assessment exists, and it goes away here rather than on a second call
 * from the browser: a failure between the two would leave the wizard offering to resume something
 * already created, and the author would either create it twice or delete the real one to stop being
 * asked.
 */
describe('what happens to the draft when the assessment lands', () => {
  it('a created assessment takes its draft with it', async () => {
    const { base, drafts } = await serve();
    await put(base, '/api/definitions/drafts', { name: 'Q3', scope: { kind: 'account' }, lookbackDays: 30 });

    await post(base, '/api/definitions', BODY);

    expect(await drafts.get('alice@example.com')).toBeUndefined();
  });

  it('a revision takes its own draft and leaves the new-assessment one alone', async () => {
    const { base, drafts } = await serve();
    const { id } = await created(base);
    await put(base, '/api/definitions/drafts', { name: 'Something else', scope: { kind: 'account' } });
    await put(base, '/api/definitions/drafts', { name: 'Q3', definitionId: id, fromVersion: 1 });

    await post(base, `/api/definitions/${id}/versions`, {
      fromVersion: 1,
      attribution: { name: 'Revised', owners: [] },
    });

    expect(await drafts.get('alice@example.com', id)).toBeUndefined();
    expect(await drafts.get('alice@example.com')).toBeDefined();
  });

  /*
   * The assessment was saved. Failing the response now would tell the author it was not, and they
   * would write it again — so a store that cannot forget the draft costs them one dismissal instead.
   */
  it('still reports the assessment as created when the draft could not be forgotten', async () => {
    const drafts = new InMemorySetupDraftStore();
    drafts.discard = () => Promise.reject(new Error('the database went away'));
    const { base, definitions } = await serve({ drafts });

    const response = await post(base, '/api/definitions', BODY);

    expect(response.status).toBe(201);
    expect(await definitions.all()).toHaveLength(1);
  });
});

/*
 * What a scope would cover, before it is saved. The point of previewing rather than waiting for the
 * run: a scope naming workspaces that have been decommissioned reads as an assessment of all of
 * them, and the place to find that out is while it can still be changed.
 */
describe('previewing what a scope covers', () => {
  async function withEstate(): Promise<Harness> {
    const scans = new InMemoryScanStore();
    await scans.save(
      scanWith({
        assessed: [
          { id: 'w1', name: 'Analytics', status: 'RUNNING' },
          { id: 'w2', name: 'Platform', status: 'RUNNING' },
        ],
        excluded: [{ id: 'w9', name: 'Retired', status: 'BANNED', reason: 'not-running' }],
      })
    );
    return serve({ scans });
  }

  it('names what is covered and what is left out, and says when the estate was read', async () => {
    const { base } = await withEstate();

    const response = await post(base, '/api/definitions/scope', {
      scope: { kind: 'selected', workspaceIds: ['w1', 'w9', 'w7'] },
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ScopePreviewPayload;
    expect(payload.assessed).toEqual([{ workspaceId: 'w1', name: 'Analytics' }]);
    expect(payload.omitted.map((one) => [one.workspaceId, one.reason])).toEqual([
      ['w7', 'unknown'],
      ['w9', 'not-running'],
    ]);
    // Assessable and deliberately left out, which is a different fact from being unreachable.
    expect(payload.outOfScope).toBe(1);
    expect(payload.complete).toBe(false);
    expect(payload.asOf).toBe(AT.toISOString());
  });

  /*
   * The region has to survive the trip through storage. `resolveScope` reads a missing home region as
   * "this deployment could not establish which region it reads" and warns that the assessment may span
   * regions that bill separately — so dropping the field when rebuilding the directory from a stored
   * scan printed that warning on every preview in an account whose region the scan had established.
   */
  it('does not warn about an unestablished region when the scan established one', async () => {
    const scans = new InMemoryScanStore();
    await scans.save(
      scanWith({
        assessed: [{ id: 'w1', name: 'Analytics', status: 'RUNNING' }],
        excluded: [],
        region: 'AP_SYDNEY',
      })
    );
    const { base } = await serve({ scans });

    const payload = (await (
      await post(base, '/api/definitions/scope', { scope: { kind: 'selected', workspaceIds: ['w1'] } })
    ).json()) as ScopePreviewPayload;

    expect(payload.description).not.toContain('Which region this deployment reads');
    expect(payload.description).not.toContain('reading across them');
  });

  it('still warns when the scan could not establish a region either', async () => {
    const scans = new InMemoryScanStore();
    await scans.save(scanWith({ assessed: [{ id: 'w1', name: 'Analytics', status: 'RUNNING' }], excluded: [] }));
    const { base } = await serve({ scans });

    const payload = (await (
      await post(base, '/api/definitions/scope', { scope: { kind: 'selected', workspaceIds: ['w1'] } })
    ).json()) as ScopePreviewPayload;

    expect(payload.description).toContain('Which region this deployment reads was not established');
  });

  it('account reach covers everything the identity can see, and leaves nothing out of scope', async () => {
    const { base } = await withEstate();

    const payload = (await (
      await post(base, '/api/definitions/scope', { scope: { kind: 'account' } })
    ).json()) as ScopePreviewPayload;

    expect(payload.assessed.map((one) => one.workspaceId)).toEqual(['w1', 'w2']);
    expect(payload.omitted).toEqual([]);
    expect(payload.outOfScope).toBe(0);
    expect(payload.complete).toBe(true);
  });

  /*
   * Nothing has read the directory, so there is nothing to hold the scope against. The wrong answer
   * is an empty assessed list, which reads as a scope that covers nothing.
   */
  it('says there is nothing to resolve against when no scan has run', async () => {
    const { base } = await serve();

    const payload = (await (
      await post(base, '/api/definitions/scope', { scope: { kind: 'account' } })
    ).json()) as ScopePreviewPayload;

    expect(payload.unavailable).toContain('No scan has run yet');
    expect(payload.complete).toBe(false);
    expect(payload.asOf).toBeUndefined();
  });

  it('passes on the collector’s own reason when the last scan could not read the directory', async () => {
    const scans = new InMemoryScanStore();
    await scans.save(
      scanWith({
        assessed: [],
        excluded: [],
        undeterminedReason: 'The workspace directory needs SELECT on system.access.workspaces_latest.',
      })
    );
    const { base } = await serve({ scans });

    const payload = (await (
      await post(base, '/api/definitions/scope', { scope: { kind: 'account' } })
    ).json()) as ScopePreviewPayload;

    expect(payload.unavailable).toContain('system.access.workspaces_latest');
    // Dated even though it is unusable, because "the last scan tried and could not" is a fact with a
    // time on it and the reader is deciding whether to run another one.
    expect(payload.asOf).toBe(AT.toISOString());
  });

  it('refuses a scope that is neither of the two kinds', async () => {
    const { base } = await withEstate();

    expect((await post(base, '/api/definitions/scope', { scope: { kind: 'everything' } })).status).toBe(400);
    expect((await post(base, '/api/definitions/scope', {})).status).toBe(400);
  });

  // It used to answer. `resolveScope` omits nothing from an empty selection, so `complete` came back
  // true and the description said the scope covered everything it claimed to — of nothing. Meanwhile
  // the same scope is refused the moment somebody saves it, so the preview was encouraging a scope the
  // next step would reject.
  it('refuses a selection that names no workspace, rather than reporting it complete', async () => {
    const { base } = await withEstate();

    const response = await post(base, '/api/definitions/scope', {
      scope: { kind: 'selected', workspaceIds: [] },
    });
    expect(response.status).toBe(400);
  });

  it('refuses a selection of nothing but blanks, which is the same scope written differently', async () => {
    const { base } = await withEstate();

    expect(
      (await post(base, '/api/definitions/scope', { scope: { kind: 'selected', workspaceIds: ['', '  '] } })).status
    ).toBe(400);
  });

  it('trims the ids it is given, so one estate cannot arrive under two fingerprints', async () => {
    const { base } = await withEstate();

    const response = await post(base, '/api/definitions/scope', {
      scope: { kind: 'selected', workspaceIds: [' w1', 'w2 '] },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { assessed: readonly { workspaceId: string }[] };
    expect(payload.assessed.map((row) => row.workspaceId)).toEqual(['w1', 'w2']);
  });

  it('refuses a caller who may not change anything, because it enumerates workspaces by name', async () => {
    const { base } = await serve({ permit: false });

    expect((await post(base, '/api/definitions/scope', { scope: { kind: 'account' } })).status).toBe(403);
  });
});

/*
 * What these routes write down about the acts.
 *
 * Held here rather than left to `check:audit-coverage`, which is a static check and can only see that
 * an act is opened and closed somewhere in the handler. It cannot see *which* outcome a path takes,
 * and the paths worth pinning are the ones an auditor reads for: an attempt on an id that does not
 * exist, and a revision refused for being made against a version somebody else has replaced. Both
 * answer 4xx without throwing, which is exactly the shape review found leaving nothing behind.
 */
describe('what the definition routes record', () => {
  it('records a create against the assessment it minted', async () => {
    const { base, audit } = await serve();

    const definition = await created(base);

    const [event] = (await audit.search()).events;
    expect(event?.action).toBe('definition.create');
    expect(event?.outcome).toBe('performed');
    expect(event?.target).toEqual({ kind: 'definition', id: definition.id });
  });

  it('records an attempt on an assessment that does not exist, with the reason the caller was given', async () => {
    const { base, audit } = await serve();

    expect((await post(base, '/api/definitions/nope/archive', {})).status).toBe(404);

    const [event] = (await audit.search()).events;
    expect(event?.action).toBe('definition.archive');
    expect(event?.outcome).toBe('failed');
    // The `error` field of the response, so the log and the caller agree on what went wrong. `http-404`
    // here would mean the net had fired and the route had said nothing about which precondition failed.
    expect(event?.reason).toBe('unknown-definition');
    expect(event?.target).toEqual({ kind: 'definition', id: 'nope' });
  });

  it('records a revision refused for being made against a replaced version', async () => {
    const { base, audit } = await serve();
    const definition = await created(base);

    const stale = await post(base, `/api/definitions/${definition.id}/versions`, {
      ...BODY,
      fromVersion: 7,
    });
    expect(stale.status).toBe(409);

    const [event] = (await audit.search({ action: 'definition.revise' })).events;
    expect(event?.outcome).toBe('failed');
    expect(event?.reason).toBe('stale-definition');
  });

  it('records the preview that could not resolve a scope as performed, since being told is an answer', async () => {
    // No scan, so there is no directory and the route answers 200 with `unavailable` set — and
    // returns early without closing the act. This is the net: the row exists because the response
    // ended, not because the handler remembered.
    const { base, audit } = await serve();

    expect((await post(base, '/api/definitions/scope', { scope: { kind: 'account' } })).status).toBe(200);

    const [event] = (await audit.search({ action: 'scope.preview' })).events;
    expect(event?.outcome).toBe('performed');
  });
});

/*
 * Targets through the route, which is where the two checks the domain cannot make happen.
 *
 * The domain refuses a target for a pillar the assessment leaves out, because that rule has to hold
 * for a stored version as well. What only a route knows is whether the pillar exists in this build's
 * catalogue at all, and how a date arrives: as a string, which has to become a `Date` before anything
 * can compare it to now.
 */
describe('committing to a score', () => {
  const BY = '2026-09-30T00:00:00.000Z';

  function withTargets(targets: unknown): Record<string, unknown> {
    return { ...BODY, targets };
  }

  it('records the commitment on the version, with the date as a date', async () => {
    const { base, definitions } = await serve();

    const response = await post(base, '/api/definitions', withTargets([{ pillar: 'security', atLeast: 80, by: BY }]));
    const payload = (await response.json()) as DefinitionPayload;

    expect(response.status).toBe(201);
    expect(payload.versions[0]?.targets).toEqual([{ pillar: 'security', atLeast: 80, by: BY }]);
    // And in the store as a Date, not the string it arrived as. A surface comparing a string to now
    // gets an answer that is wrong without being an error.
    const stored = await definitions.get('d1');
    expect(stored?.versions[0]?.targets?.[0]?.by).toBeInstanceOf(Date);
  });

  it('omits the field entirely when nothing was committed', async () => {
    const { base } = await serve();

    expect((await created(base)).versions[0]?.targets).toBeUndefined();
  });

  it('refuses a target for a pillar this build does not measure', async () => {
    const { base } = await serve({ pillars: ['security', 'cost-optimization'] });

    const response = await post(base, '/api/definitions', withTargets([{ pillar: 'securty', atLeast: 80, by: BY }]));

    expect(response.status).toBe(400);
    expect(String(((await response.json()) as { message: string }).message)).toContain('does not measure securty');
  });

  it('refuses a date it cannot read, naming the pillar it was on', async () => {
    const { base } = await serve();

    const response = await post(
      base,
      '/api/definitions',
      withTargets([{ pillar: 'security', atLeast: 80, by: 'the end of Q3' }])
    );

    expect(response.status).toBe(400);
    expect(String(((await response.json()) as { message: string }).message)).toContain('security');
  });

  it('refuses a target that says nothing about when or how much', async () => {
    const { base } = await serve();

    for (const target of [
      { pillar: 'security', atLeast: 80 },
      { pillar: 'security', by: BY },
      { atLeast: 80, by: BY },
    ]) {
      expect((await post(base, '/api/definitions', withTargets([target]))).status).toBe(400);
    }
  });

  it('refuses targets sent as anything but a list', async () => {
    const { base } = await serve();

    expect((await post(base, '/api/definitions', withTargets({ security: 80 }))).status).toBe(400);
  });

  it('is a revision on its own, so a bar can move without the measurement changing', async () => {
    const { base } = await serve();
    const definition = await created(base);

    const response = await post(base, `/api/definitions/${definition.id}/versions`, {
      fromVersion: 1,
      targets: [{ pillar: 'security', atLeast: 80, by: BY }],
      note: 'Committed to 80 in security by the end of Q3.',
    });
    const payload = (await response.json()) as DefinitionPayload;

    expect(response.status).toBe(201);
    expect(payload.versions).toHaveLength(2);
    expect(payload.versions[1]?.targets).toEqual([{ pillar: 'security', atLeast: 80, by: BY }]);
    // The whole reason targets are not fingerprinted: setting one must not end the customer's trend.
    expect(payload.versions[1]?.fingerprint).toBe(payload.versions[0]?.fingerprint);
  });

  it('withdraws a commitment with an empty list, and the version that held it keeps it', async () => {
    const { base } = await serve();
    const definition = await created(base);
    await post(base, `/api/definitions/${definition.id}/versions`, {
      fromVersion: 1,
      targets: [{ pillar: 'security', atLeast: 80, by: BY }],
    });

    const response = await post(base, `/api/definitions/${definition.id}/versions`, {
      fromVersion: 2,
      targets: [],
    });
    const payload = (await response.json()) as DefinitionPayload;

    expect(response.status).toBe(201);
    expect(payload.versions[2]?.targets).toBeUndefined();
    expect(payload.versions[1]?.targets).toHaveLength(1);
  });
});
