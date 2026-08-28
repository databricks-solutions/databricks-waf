// Serving the guidance, including the case where there is none.
//
// The interesting assertion here is the absent one. A question nobody has written up yet is the
// state most of the catalogue is in, and the tempting answer to a request for it is 404 — which
// would have every requirement pane in the app logging an error for a condition that is normal. So
// the route answers 200 and says `absent`, and this test holds that: a build that "fixed" it to a
// 404 would pass a status-code reading of the contract and break the pane.
//
// The second assertion is that a draft is withheld. A scaffolded entry has the shape of guidance and
// none of the content, and serving it would put empty headings above somebody's answer form. Withheld
// reads as "nobody has written this", which is true.

import express from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { InMemoryScanStore } from '../scan/store.js';
import { ScanRunner } from '../scan/runner.js';
import type { Guidance, GuidanceLibrary } from '../guidance/guidance.js';
import { registerApi } from './routes.js';
import type { GuidanceResponse } from '../../shared/api/contract.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();
const servers: Server[] = [];

afterAll(() => closeServed(servers));

const WRITTEN: Guidance = {
  controlId: 'OE-01-03',
  pillarId: 'operational-excellence',
  status: 'authored',
  means: 'Changes to production reach it through a pipeline rather than a person.',
  matters: 'A change nobody can reproduce is a change nobody can roll back.',
  good: ['Deployment is a pipeline run', 'The pipeline runs tests'],
  examples: { strong: 'Bundles from CI', partial: 'Two of six workspaces', weak: 'Notebooks by hand' },
  verify: [{ how: 'ui', where: 'Workflows, the job that deploys', expect: 'a git source' }],
  pitfalls: ['A pipeline that exists but is bypassed under pressure'],
  partialWhen: 'Some estates deploy this way and others do not.',
  ownerRole: 'Platform engineering',
  lastReviewed: '2026-08-01',
  references: ['https://docs.databricks.com/dev-tools/bundles/index.html'],
};

const SCAFFOLD: Guidance = {
  controlId: 'REL-04-04',
  pillarId: 'reliability',
  status: 'draft',
  good: [],
  verify: [],
  pitfalls: [],
  references: [],
};

function libraryOf(...entries: readonly Guidance[]): GuidanceLibrary {
  return {
    entries: new Map(entries.map((entry) => [entry.controlId, entry])),
    authored: entries.filter((entry) => entry.status === 'authored').length,
    advised: entries.filter((entry) => entry.status === 'authored' && entry.advice != null).length,
  };
}

async function serving(guidance?: GuidanceLibrary): Promise<string> {
  const store = new InMemoryScanStore();
  const routes = express();
  routes.use(express.json());
  registerApi(routes, {
    catalogue,
    registry,
    runner: new ScanRunner({ catalogue, registry, store, measuredPillars: ['operational-excellence'] }),
    store,
    host: 'http://127.0.0.1:1',
    // Never exercised: reading guidance is reading, and reading is not gated.
    assessorGroup: 'waf-assessors',
    pillars: ['operational-excellence'],
    collectorsFor: () => [],
    ...(guidance == null ? {} : { guidance }),
  });

  return servedAt(routes, servers);
}

async function ask(url: string, controlId: string): Promise<{ status: number; body: GuidanceResponse }> {
  const response = await fetch(`${url}/api/guidance/${controlId}`);
  return { status: response.status, body: (await response.json()) as GuidanceResponse };
}

// Nothing here needs a scan: guidance is content the build ships, not something a run produces.
describe('the guidance a requirement pane asks for', () => {
  it('serves what somebody wrote, whole', async () => {
    const url = await serving(libraryOf(WRITTEN, SCAFFOLD));
    const { status, body } = await ask(url, 'OE-01-03');

    expect(status).toBe(200);
    expect(body.status).toBe('authored');
    expect(body.guidance?.means).toBe(WRITTEN.means);
    expect(body.guidance?.good).toEqual(WRITTEN.good);
    expect(body.guidance?.examples.partial).toBe('Two of six workspaces');
    expect(body.guidance?.verify).toEqual([
      { how: 'ui', where: 'Workflows, the job that deploys', expect: 'a git source' },
    ]);
    expect(body.guidance?.partialWhen).toBe(WRITTEN.partialWhen);
    expect(body.guidance?.lastReviewed).toBe('2026-08-01');
  });

  it('answers 200 and says absent for a question nobody has written up', async () => {
    const url = await serving(libraryOf(WRITTEN));
    // A real control with no entry. That is the state most of the catalogue is in.
    const { status, body } = await ask(url, 'OE-01-04');

    expect(status).toBe(200);
    expect(body).toEqual({ controlId: 'OE-01-04', status: 'absent' });
  });

  it('answers 404 for a control that is not in the catalogue at all', async () => {
    // The other kind of nothing, and the caller can act on the difference: one means nobody has
    // written this yet, the other means the client asked about a requirement that does not exist.
    const url = await serving(libraryOf(WRITTEN));
    const response = await fetch(`${url}/api/guidance/SEC-99-99`);

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error?: string }).error).toBe('control-not-found');
  });

  it('withholds a scaffold, because half an entry is worse than none', async () => {
    const url = await serving(libraryOf(WRITTEN, SCAFFOLD));
    const { body } = await ask(url, 'REL-04-04');

    expect(body.status).toBe('absent');
    expect(body.guidance).toBeUndefined();
  });

  it('serves the advice block when there is one, so a finding can render it', async () => {
    const advised: Guidance = {
      ...WRITTEN,
      advice: {
        startFrom: 'Deploy from a bundle in CI, with the workspace path read-only to everybody but the pipeline.',
        dependsOn: ['A team without CI needs the read-only step first', 'A regulated estate wants an approval gate'],
        path: ['Put the definitions in git', 'Deploy one workspace from CI', 'Then close the workspace path'],
        costs: ['A pipeline is somebody’s to maintain', 'An urgent fix now waits for a pipeline run'],
        retain: 'The deploy run that last promoted production, and what it deployed.',
        revisit: 'A new workspace, or the first time somebody edits production by hand.',
      },
    };
    const url = await serving(libraryOf(advised));
    const { body } = await ask(url, 'OE-01-03');

    expect(body.guidance?.advice?.startFrom).toMatch(/Deploy from a bundle in CI/);
    expect(body.guidance?.advice?.path).toHaveLength(3);
    expect(body.guidance?.advice?.costs).toHaveLength(2);
  });

  it('omits advice rather than sending an empty one, for the entries written before it existed', async () => {
    // Most of the corpus. The panel decides what to render from the field's absence, so an empty
    // object here would put six headings and no bodies on every finding in the product.
    const url = await serving(libraryOf(WRITTEN));
    const { body } = await ask(url, 'OE-01-03');

    expect(body.guidance).toBeDefined();
    expect(body.guidance && 'advice' in body.guidance).toBe(false);
  });

  it('says absent rather than failing when the build shipped no guidance at all', async () => {
    // The state a deploy that lost `config/guidance/` is in. The assessment is still worth serving.
    const url = await serving(undefined);
    const { status, body } = await ask(url, 'OE-01-03');

    expect(status).toBe(200);
    expect(body.status).toBe('absent');
  });
});
