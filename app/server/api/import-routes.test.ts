// Uploading admin-collected evidence, over a real socket.
//
// A real HTTP server rather than a called handler, because three of the things this endpoint promises
// are properties of the wire and disappear the moment the request is a plain object: that the
// framework's JSON parser does not claim the body first, that a `Content-Length` the sender lied about
// is caught while the bytes arrive rather than after, and that the stream is decoded as strict UTF-8.
// A test driving the handler directly would pass with all three broken.
//
// `express.json()` is installed here on purpose, matching how the app is assembled. Its presence is
// the reason the endpoint takes bytes at all, so leaving it out of the harness would remove the
// condition the design exists for.
//
// Almost every test is a refusal. That is the shape the feature has: one path accepts a file and
// eleven refuse one, and each refusal is a different sentence somebody has to be able to act on.

import express from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { EvidenceImportVerdictPayload, EvidenceImportsPayload } from '../../shared/api/contract.js';
import { envelope } from '../import/envelope-fixture.js';
import { ReplayedImportError, InMemoryEvidenceImportStore, type EvidenceImportStore } from '../import/store.js';
import { digestOf } from '../import/trust.js';
import { MAX_BYTES, REQUIRED_CONTENT_TYPE } from '../import/read.js';
import { InMemoryScanStore, type ScanStore } from '../scan/store.js';
import type { Scan } from '../scan/scan.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { registerImportRoutes } from './import-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const NOW = new Date('2026-08-03T12:00:00Z');
const WORKSPACE = '7000000000000001';
const SCRIPT_DIGEST = `sha256:${'a'.repeat(64)}`;

class Refused extends Error {}

/** A file whose recorded digest matches its probes, which is what the script writes. */
function file(overrides: Record<string, unknown> = {}): string {
  const raw = envelope(overrides);
  return JSON.stringify({ ...raw, digest: digestOf(raw.probes) });
}

interface Harness {
  readonly base: string;
  readonly imports: EvidenceImportStore;
  readonly scans: ScanStore;
  /** What the route wrote down about the upload, so a test can read it back. */
  readonly audit: AuditLog;
}

async function serve(
  over: {
    readonly imports?: EvidenceImportStore;
    readonly omitStore?: boolean;
    readonly scans?: ScanStore;
    readonly permit?: boolean;
    readonly actor?: string;
    readonly scriptDigest?: string | undefined;
    readonly now?: Date;
  } = {}
): Promise<Harness> {
  const app = express();
  // The condition this endpoint is designed around, present in the harness for that reason.
  app.use(express.json());

  const imports = over.imports ?? new InMemoryEvidenceImportStore();
  const scans = over.scans ?? new InMemoryScanStore();
  const audit = new InMemoryAuditLog();
  const recorder = new AuditRecorder(audit);

  registerImportRoutes(app, {
    ...(over.omitStore === true ? {} : { imports }),
    store: scans,
    // The real recorder, so the reasons this route records for a refused file are asserted against
    // the route rather than against a stub that agrees with whatever it was handed.
    permitted: (_request, response, action) =>
      over.permit === false
        ? Promise.reject(new Refused('not permitted'))
        : Promise.resolve({
            actor: over.actor ?? 'importer@example.com',
            act: closedWhenAnswered(
              recorder.begin(action, {
                actor: over.actor ?? 'importer@example.com',
                executionMode: 'on-behalf-of-user',
              }),
              response
            ),
          }),
    respondToFailure: (response, cause) => {
      if (cause instanceof Refused) {
        response.status(403).json({ error: 'not-permitted', message: cause.message });
        return;
      }
      response.status(500).json({ error: 'unexpected', message: String(cause) });
    },
    publishedScriptDigest: () => ('scriptDigest' in over ? over.scriptDigest : SCRIPT_DIGEST),
    now: () => over.now ?? NOW,
  });

  const base = await servedAt(app, servers);
  return { base, imports, scans, audit };
}

/**
 * A scan whose estate names some workspaces, which is what gives the target check something to hold.
 *
 * A whole `Scan` rather than a cast-down fragment. The endpoint only reads `estate.assessed`, so a
 * fragment would pass — and would keep passing if a later change made the target depend on the stamp
 * or the scope, since the type system would have stopped describing what the route was handed.
 */
function scanned(...workspaceIds: readonly string[]): ScanStore {
  const store = new InMemoryScanStore();
  const scan: Scan = {
    id: 'latest',
    startedAt: NOW,
    finishedAt: new Date(NOW.getTime() + 60_000),
    state: 'complete',
    stamp: {
      catalogueVersion: '9',
      catalogueFingerprint: 'sha256:abc',
      executionMode: 'on-behalf-of-user',
      actor: 'assessor@example.com',
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
    estate: {
      assessed: workspaceIds.map((id) => ({ id, name: `ws-${id}`, status: 'RUNNING' })),
      excluded: [],
    },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
  };
  void store.save(scan);
  return store;
}

async function upload(
  base: string,
  body: string | Buffer,
  headers: Readonly<Record<string, string>> = {}
): Promise<{
  readonly status: number;
  // The verdict shape for a judged file, and the error shape for one the layers below never got to
  // judge. Widened here rather than in the contract, because the two are different responses and a
  // client that treated them as one would report an unparseable file as a refused reading.
  readonly payload: EvidenceImportVerdictPayload & { error?: string; message?: string; at?: string };
}> {
  const response = await fetch(`${base}/api/evidence/imports`, {
    method: 'POST',
    headers: { 'content-type': REQUIRED_CONTENT_TYPE, ...headers },
    body,
  });
  return { status: response.status, payload: (await response.json()) as never };
}

function reasons(payload: EvidenceImportVerdictPayload): readonly string[] {
  return payload.refusals.map((note) => note.reason);
}

function cautions(payload: EvidenceImportVerdictPayload): readonly string[] {
  return payload.cautions.map((note) => note.reason);
}

describe('a file the script wrote, uploaded today', () => {
  it('is accepted, and what it answers is reported back', async () => {
    const { base, imports } = await serve({ scans: scanned(WORKSPACE) });

    const { status, payload } = await upload(base, file());

    expect(status).toBe(201);
    expect(payload.accepted).toBe(true);
    expect(payload.refusals).toEqual([]);
    expect(payload.imported?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.imported?.observed).toBe(1);
    expect(payload.imported?.requirements).toBe(1);
    expect(payload.imported?.workspaceTier).toBe(true);
    expect(payload.imported?.accountTier).toBe(false);
    // Who uploaded it, from the gate — never from the file, which cannot be believed about that.
    expect(payload.imported?.importedBy).toBe('importer@example.com');
    // Who collected it, from the file, which is the only place that is recorded.
    expect(payload.imported?.collectedBy).toBe('admin@example.com');
    expect(await imports.all()).toHaveLength(1);
  });

  it('says the account tier did not run, since half the requirements depend on it', async () => {
    const { base } = await serve({ scans: scanned(WORKSPACE) });
    const { payload } = await upload(base, file());
    expect(cautions(payload)).toContain('tier-not-run');
  });

  it('is listed afterwards, with whether the record survives a restart', async () => {
    const { base } = await serve({ scans: scanned(WORKSPACE) });
    await upload(base, file());

    const response = await fetch(`${base}/api/evidence/imports`);
    const payload = (await response.json()) as EvidenceImportsPayload;

    expect(payload.imports).toHaveLength(1);
    expect(payload.acceptedForDays).toBe(30);
    // False here because the harness holds them in memory, and the page has to be able to say so.
    expect(payload.durable).toBe(false);
  });
});

describe('a file this app declines to believe', () => {
  it('refuses an edited reading with a 422, because re-sending it will not help', async () => {
    const { base, imports } = await serve({ scans: scanned(WORKSPACE) });
    const raw = JSON.parse(file()) as Record<string, unknown>;
    const probes = raw.probes as Record<string, unknown>[];
    probes[0] = { ...probes[0], value: { enableIpAccessLists: 'false' } };

    const { status, payload } = await upload(base, JSON.stringify(raw));

    expect(status).toBe(422);
    expect(reasons(payload)).toContain('digest-mismatch');
    // The point of the whole endpoint: a refused file leaves the app exactly as it was.
    expect(await imports.all()).toEqual([]);
  });

  it('refuses a second upload of the same file with a 409, naming state as the reason', async () => {
    const { base, imports } = await serve({ scans: scanned(WORKSPACE) });
    const bytes = file();
    await upload(base, bytes);

    const { status, payload } = await upload(base, bytes);

    expect(status).toBe(409);
    expect(reasons(payload)).toContain('replayed');
    expect(await imports.all()).toHaveLength(1);
  });

  it('answers the insert-time race with a verdict, not a bare error, because the page reads every 409 as one', async () => {
    // Two uploads of one file can pass the digest check together and collide at the index. The page
    // parses every 409 as a verdict and reads its refusals, so this path has to return that shape and
    // not `{ error, message }` — otherwise the one screen breaks on the one race the index exists for.
    const raced: EvidenceImportStore = {
      durable: true,
      all: () => Promise.resolve([]),
      summaries: () => Promise.resolve([]),
      digests: () => Promise.resolve(new Set<string>()),
      record: (evidence) => Promise.reject(new ReplayedImportError(evidence.digest)),
    };
    const { base } = await serve({ imports: raced, scans: scanned(WORKSPACE) });

    const { status, payload } = await upload(base, file());

    expect(status).toBe(409);
    expect(payload.accepted).toBe(false);
    expect(reasons(payload)).toContain('replayed');
    expect(payload.refusals?.[0]?.message).toContain('imported before');
  });

  it('refuses a collection older than the window it is accepted for', async () => {
    const { base } = await serve({ scans: scanned(WORKSPACE) });
    const { status, payload } = await upload(base, file({ generated_at: '2026-06-01T00:00:00Z' }));

    expect(status).toBe(422);
    expect(reasons(payload)).toContain('expired');
  });

  it('refuses a file collected against a workspace this assessment does not cover', async () => {
    const { base } = await serve({ scans: scanned('9999999999999999') });
    const { status, payload } = await upload(base, file());

    expect(status).toBe(422);
    expect(reasons(payload)).toContain('wrong-workspace');
    expect(payload.refusals[0]?.message).toContain(WORKSPACE);
  });

  it('reports every reason at once, so one fix does not reveal the next', async () => {
    const { base } = await serve({ scans: scanned('9999999999999999') });
    const { payload } = await upload(base, file({ generated_at: '2026-06-01T00:00:00Z' }));

    expect(reasons(payload)).toEqual(expect.arrayContaining(['expired', 'wrong-workspace']));
  });
});

describe('a file this app cannot read', () => {
  it('refuses a body the framework would have parsed, and says what to send', async () => {
    const { base } = await serve();
    const { status, payload } = await upload(base, file(), { 'content-type': 'application/json' });

    expect(status).toBe(415);
    expect(payload.error).toBe('wrong-content-type');
    expect(payload.message).toContain(REQUIRED_CONTENT_TYPE);
  });

  it('refuses an upload over the cap with a 413', async () => {
    const { base } = await serve();
    const { status, payload } = await upload(base, Buffer.alloc(MAX_BYTES + 1024, 0x20));

    expect(status).toBe(413);
    expect(payload.error).toBe('too-large');
  });

  it('refuses text that is not JSON, before anything asks what it says', async () => {
    const { base } = await serve();
    const { status, payload } = await upload(base, 'this is not a file');

    expect(status).toBe(400);
    expect(payload.error).toBe('not-json');
  });

  it('refuses a document that tries to reach the prototype, naming the key', async () => {
    const { base } = await serve();
    const { status, payload } = await upload(base, '{"schema":"waf-admin-evidence/1","__proto__":{"x":1}}');

    expect(status).toBe(400);
    expect(payload.error).toBe('forbidden-key');
  });

  it('refuses an envelope missing a field, naming the field rather than the file', async () => {
    const { base } = await serve();
    const { status, payload } = await upload(base, JSON.stringify({ ...JSON.parse(file()), cli: {} }));

    expect(status).toBe(400);
    expect(payload.error).toBe('bad-field');
    expect(payload.at).toBe('cli.version');
  });

  it('refuses a schema this app predates, with the remedy in the reason', async () => {
    const { base } = await serve();
    const { status, payload } = await upload(
      base,
      JSON.stringify({ ...JSON.parse(file()), schema: 'waf-admin-evidence/2' })
    );

    expect(status).toBe(400);
    expect(payload.error).toBe('unknown-schema');
  });
});

describe('the endpoint itself', () => {
  it('refuses a caller who may not change anything, before reading the body', async () => {
    const { base, imports } = await serve({ permit: false });
    const { status } = await upload(base, file());

    expect(status).toBe(403);
    expect(await imports.all()).toEqual([]);
  });

  it('refuses to accept anything when there is nowhere to keep it', async () => {
    const { base } = await serve({ omitStore: true });
    const { status, payload } = await upload(base, file());

    expect(status).toBe(503);
    expect(payload.error).toBe('imports-unavailable');
  });

  it('answers the list with nothing held rather than an error, so the page can explain itself', async () => {
    const { base } = await serve({ omitStore: true });
    const response = await fetch(`${base}/api/evidence/imports`);
    const payload = (await response.json()) as EvidenceImportsPayload;

    expect(response.status).toBe(200);
    expect(payload.imports).toEqual([]);
    expect(payload.durable).toBe(false);
  });

  it('cautions when the collecting script was not the published one', async () => {
    const { base } = await serve({ scans: scanned(WORKSPACE), scriptDigest: `sha256:${'c'.repeat(64)}` });
    const { payload } = await upload(base, file());

    expect(cautions(payload)).toContain('script-differs');
  });

  it('raises no such caution when this install cannot read its own copy', async () => {
    // Absent is not "different". An install that cannot digest its own script has established
    // nothing about the collecting copy, and saying otherwise would be an invented finding.
    const { base } = await serve({ scans: scanned(WORKSPACE), scriptDigest: undefined });
    const { payload } = await upload(base, file());

    expect(cautions(payload)).not.toContain('script-differs');
  });

  it('cautions that nothing was held against the estate when no scan has run', async () => {
    const { base } = await serve();
    const { status, payload } = await upload(base, file());

    // Accepted rather than refused: the first assessment of an estate is exactly the case where the
    // account-plane requirements have never been answered, and refusing here would close it.
    expect(status).toBe(201);
    expect(cautions(payload)).toContain('target-unverified');
  });
});
