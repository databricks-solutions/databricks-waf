// Declaring what this organisation serves, and reading how ready it is.
//
// What a declaration is and what it refuses is `foundation/serving-asset.test.ts`; what the two-pass
// read does with a statement that fails is `foundation/readiness-read.test.ts`. What only a route can
// get wrong is here, and it is four things.
//
// The version is the store's rather than the caller's, so two people declaring from the same page
// collide instead of one silently replacing the other. The three not-a-reading cases — nothing
// declared, no warehouse, a statement that did not answer — come back 200 and say which one happened,
// because a page that failed to load says less than one that explains itself. A declaration is never
// edited: there is no PUT and no DELETE, which is the record's guarantee written as a surface. And no
// endpoint returns a score, which is the module's refusal to add eight populations held one layer up
// where a payload could quietly undo it.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { FoundationReadinessPayload, ServingDeclarationPayload } from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { InMemoryServingStore, nextDeclaration, type ServingStore } from '../foundation/serving-store.js';
import type { ServingDraft } from '../foundation/serving-asset.js';
import type { ServingSql } from '../foundation/readiness-read.js';
import { registerFoundationRoutes } from './foundation-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const NOW = new Date('2026-08-15T09:00:00.000Z');

const DRAFT: ServingDraft = {
  named: [{ catalog: 'main', schema: 'gold', table: 'orders' }],
  tagged: [{ key: 'certification', values: ['gold'], at: ['table'] }],
  requiredTagKeys: ['owner_team'],
  requiredMetadata: ['description', 'owner'],
  policy: [{ classification: 'pii', requires: ['column-mask'] }],
};

class Refused extends Error {}

/** Statements that answer for one asset, so a reading has something in it to check. */
function answering(): ServingSql {
  return {
    population: () =>
      Promise.resolve({
        matchPopulation: 1,
        matches: [
          {
            qualified: 'main.gold.orders',
            catalog: 'main',
            schema: 'gold',
            table: 'orders',
            description: 'Orders as served',
            owner: 'data-platform',
          },
        ],
      }),
    tags: () =>
      Promise.resolve({
        tagPopulation: 1,
        tags: [{ qualified: 'main.gold.orders', key: 'owner_team', value: 'platform' }],
      }),
    facts: () =>
      Promise.resolve({
        assetPopulation: 1,
        assets: [
          {
            qualified: 'main.gold.orders',
            relationKind: 'MANAGED',
            storageFormat: 'DELTA',
            columnCount: 3,
            commentedColumns: 3,
            lineageEvents: 4,
            semanticReaders: 1,
            maskedColumns: 0,
            rowFilters: 0,
          },
        ],
      }),
    quality: () =>
      Promise.resolve({
        qualityPopulation: 1,
        statuses: [{ qualified: 'main.gold.orders', qualityStatus: 'ok' }],
      }),
    classes: () =>
      Promise.resolve({ classPopulation: 1, classified: [{ qualified: 'main.gold.orders', classifications: [] }] }),
  };
}

interface Harness {
  readonly base: string;
  readonly store: ServingStore;
  readonly audit: AuditLog;
}

async function serve(
  over: {
    readonly omitStore?: boolean;
    readonly omitSql?: boolean;
    readonly sql?: ServingSql;
    readonly permit?: boolean;
    readonly actor?: string;
  } = {}
): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const store = new InMemoryServingStore();
  const audit = new InMemoryAuditLog();
  const recorder = new AuditRecorder(audit);
  const actor = over.actor ?? 'priya@example.com';

  registerFoundationRoutes(app, {
    ...(over.omitStore === true ? {} : { serving: store }),
    servingStorage: 'Kept in the waf schema of the bound database.',
    ...(over.omitSql === true ? {} : { servingSql: () => Promise.resolve(over.sql ?? answering()) }),
    now: () => NOW,
    permitted: (
      _request: Request,
      response: Response,
      action: AuditAction,
      context?: { readonly target?: AuditTarget }
    ) =>
      over.permit === false
        ? Promise.reject(new Refused('not permitted'))
        : Promise.resolve({
            actor,
            act: closedWhenAnswered(
              recorder.begin(action, { actor, executionMode: 'on-behalf-of-user' }, context ?? {}),
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
  });

  const base = await servedAt(app, servers);
  return { base, store, audit };
}

async function send(base: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

async function read<T>(base: string, path: string): Promise<T> {
  return (await (await fetch(`${base}${path}`)).json()) as T;
}

async function acts(audit: AuditLog): Promise<readonly (readonly [string, string, string | undefined])[]> {
  const { events } = await audit.search();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => [event.action, event.outcome, event.target?.id] as const);
}

describe('declaring what is served', () => {
  it('stores the first declaration as version 1 and records who made it', async () => {
    const { base, audit } = await serve();

    const { status, body } = await send(base, '/api/foundation/serving', DRAFT);
    const declaration = body as ServingDeclarationPayload;

    expect(status).toBe(201);
    expect(declaration.version).toBe(1);
    expect(declaration.declaredBy).toBe('priya@example.com');
    expect(declaration.declaredAt).toBe(NOW.toISOString());
    expect(declaration.fingerprint).toMatch(/^sha256:[0-9a-f]+$/);
    expect(await acts(audit)).toEqual([['serving.declare', 'performed', '1']]);
  });

  it('returns the assessment identity a scoped declaration is stored under', async () => {
    const { base } = await serve();

    const written = await send(base, '/api/foundation/serving?definitionId=customer-assessment', DRAFT);
    expect(written.status).toBe(201);
    expect(written.body).toMatchObject({ definitionId: 'customer-assessment', version: 1 });

    const read = await fetch(`${base}/api/foundation/serving?definitionId=customer-assessment`);
    expect(await read.json()).toMatchObject({
      declaration: { definitionId: 'customer-assessment', version: 1 },
    });
  });

  it('numbers a revision from what is stored, not from what the caller sent', async () => {
    // The lost update this exists to stop: a caller holding a page from before the last revision
    // sends version 1 and would replace what it has never seen. The number is read here.
    const { base } = await serve();
    await send(base, '/api/foundation/serving', DRAFT);

    const { body } = await send(base, '/api/foundation/serving', { ...DRAFT, version: 1 });

    expect((body as ServingDeclarationPayload).version).toBe(2);
  });

  it('refuses a declaration that would classify an asset by its name, with the reason', async () => {
    const { base, audit } = await serve();

    const { status, body } = await send(base, '/api/foundation/serving', { ...DRAFT, named: [], tagged: [] });

    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe('invalid-declaration');
    expect(await acts(audit)).toEqual([['serving.declare', 'failed', undefined]]);
  });

  it('refuses to declare at all when nothing is kept, rather than losing one on the next deploy', async () => {
    const { base } = await serve({ omitStore: true });

    const { status, body } = await send(base, '/api/foundation/serving', DRAFT);

    expect(status).toBe(503);
    expect((body as { message: string }).message).toContain('Bind a database');
  });

  it('records the refusal when the caller may not declare', async () => {
    const { base, audit } = await serve({ permit: false });

    const { status } = await send(base, '/api/foundation/serving', DRAFT);

    expect(status).toBe(403);
    expect(await acts(audit)).toEqual([]);
  });

  it('answers that nothing is declared rather than 404, because no declaration is an answer', async () => {
    const { base } = await serve();

    const payload = await read<{ declaration: unknown; durable: boolean }>(base, '/api/foundation/serving');

    expect(payload.declaration).toBeNull();
    expect(payload.durable).toBe(false);
  });

  it('has no route that edits or removes a declaration', async () => {
    const { base } = await serve();
    await send(base, '/api/foundation/serving', DRAFT);

    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${base}/api/foundation/serving`, { method });
      expect(response.status, method).toBe(404);
    }
  });
});

describe('reading how ready the declared data is', () => {
  it('reports eight dimensions of the declared population, each with what its share is a share of', async () => {
    const { base } = await serve();
    await send(base, '/api/foundation/serving', DRAFT);

    const payload = await read<FoundationReadinessPayload>(base, '/api/foundation/readiness');

    expect(payload.declaration?.version).toBe(1);
    expect(payload.population.assets).toBe(1);
    expect(payload.dimensions).toHaveLength(8);
    for (const reading of payload.dimensions) {
      expect(reading.denominator.of, reading.id).toMatch(/\S/);
      expect(reading.label, reading.id).toMatch(/\S/);
      expect(reading.asks, reading.id).toMatch(/\S/);
      expect(reading.sources.length, reading.id).toBeGreaterThan(0);
    }
    expect(new Set(payload.dimensions.map((reading) => reading.area))).toEqual(
      new Set(['governance', 'metadata', 'semantics', 'freshness', 'performance'])
    );
    expect(payload.unread).toEqual([]);
  });

  it('carries no total, because the eight are shares of eight different populations', async () => {
    const { base } = await serve();
    await send(base, '/api/foundation/serving', DRAFT);

    const payload = await read<Record<string, unknown>>(base, '/api/foundation/readiness');

    for (const field of ['score', 'total', 'overall', 'readiness', 'percent']) {
      expect(payload[field], field).toBeUndefined();
    }
  });

  it('says what it will not report and what settled that, on every reading', async () => {
    const { base } = await serve();
    await send(base, '/api/foundation/serving', DRAFT);

    const payload = await read<FoundationReadinessPayload>(base, '/api/foundation/readiness');

    expect(payload.absent.map((one) => one.what)).toContain('how much any of this is used through Genie');
    for (const absence of payload.absent) expect(absence.measured).toMatch(/\S/);
  });

  it('names the statement that did not answer rather than reporting an estate with nothing in it', async () => {
    const { base } = await serve({
      sql: { ...answering(), facts: () => Promise.reject(new Error('the warehouse timed out')) },
    });
    await send(base, '/api/foundation/serving', DRAFT);

    const payload = await read<FoundationReadinessPayload>(base, '/api/foundation/readiness');

    expect(payload.unread).toEqual([
      { statement: 'sql:serving.facts', kind: 'failed', because: 'the warehouse timed out' },
    ]);
    const lineage = payload.dimensions.find((one) => one.id === 'lineage');
    expect(lineage?.standing).toBe('unmeasured');
    expect(lineage?.share).toBeNull();
  });

  it('says a warehouse is missing rather than failing, on an install still being set up', async () => {
    const { base } = await serve({ omitSql: true });
    await send(base, '/api/foundation/serving', DRAFT);

    const response = await fetch(`${base}/api/foundation/readiness`);
    const payload = (await response.json()) as FoundationReadinessPayload;

    expect(response.status).toBe(200);
    expect(payload.unavailable).toContain('No SQL warehouse');
    expect(payload.declaration?.version).toBe(1);
  });

  it('runs no statement where nothing is declared, and says that is why', async () => {
    let ran = 0;
    const counting: ServingSql = {
      population: () => {
        ran += 1;
        return answering().population('', '');
      },
      tags: (assets) => answering().tags(assets),
      facts: (assets) => answering().facts(assets),
      quality: (assets) => answering().quality(assets),
      classes: (assets) => answering().classes(assets),
    };
    const { base } = await serve({ sql: counting });

    const payload = await read<FoundationReadinessPayload>(base, '/api/foundation/readiness');

    expect(ran).toBe(0);
    expect(payload.population.undeclared).toBe(true);
    expect(payload.declaration).toBeNull();
    expect(payload.dimensions.every((one) => one.standing === 'unmeasured')).toBe(true);
  });

  it('reads the declaration that is current, so a revision moves the reading with it', async () => {
    const { base, store } = await serve();
    await send(base, '/api/foundation/serving', DRAFT);
    await store.declare(
      nextDeclaration({ ...DRAFT, requiredMetadata: ['description'] }, await store.current(), 'sam@example.com', NOW)
    );

    const payload = await read<FoundationReadinessPayload>(base, '/api/foundation/readiness');

    expect(payload.declaration?.version).toBe(2);
    expect(payload.declaration?.requiredMetadata).toEqual(['description']);
  });
});
