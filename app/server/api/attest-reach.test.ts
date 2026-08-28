// Every requirement told to go and answer it can be answered.
//
// The bug this exists for was silent in a way the other tests here cannot be. Nothing threw, no
// status code was wrong, and the finding rendered exactly as designed: SCP-03-07 came back
// `unmeasurable`, said an answer was the way to settle it, and offered a link to the page that takes
// answers. That page listed 104 requirements and SCP-03-07 was not among them. The reader followed
// correct advice to a page with nothing on it for them, and no test on either side was wrong —
// the findings were right about the requirement and the answers page was right about its own list.
//
// The cause was a blind spot rather than a mistake. `beyondAnyInstall` reasons about the signals a
// requirement needs: where every one of them wants a scope no install is granted, an answer is the
// only route, and that is right for the 40 it finds. SCP-03-07's one signal is the serving census,
// which is grantable and answered in full — the requirement is measurable right up to the point the
// resolver asks about the protection in front of those endpoints, which needs `networking` and the
// account plane. Statically it looks readable. Only running it reveals otherwise.
//
// So the invariant is asserted end to end, across the whole framework, against findings from real
// resolvers rather than fixtures: if a finding's remedy says answer this, the answers endpoint has a
// slot for it. That holds whatever new resolver decides at runtime that it cannot see what it needs.

import express from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { observed, type SignalId, type SignalResult } from '../collect/signal.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { resolveControl } from '../resolve/resolver.js';
import type { Finding } from '../resolve/finding.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import { InMemoryScanStore } from '../scan/store.js';
import { InMemoryAttestationStore } from '../attest/store.js';
import { ScanRunner } from '../scan/runner.js';
import { registerApi } from './routes.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();
const servers: Server[] = [];

afterAll(() => closeServed(servers));

/**
 * The serving census, which has to have answered for the case under test to arise at all.
 *
 * With no signals at all SCP-03-07 resolves to `grant` — correctly, because a scan that could not
 * list the endpoints genuinely wants the read fixed rather than a person's opinion. Its remedy only
 * becomes `attest` once the list is in hand and the protection in front of it is still unreadable,
 * so the fixture has to supply the one and not the other. That is the whole shape of the bug: it
 * lives on the *successful* path.
 */
const SERVING = 'rest:workspace:serving-endpoints' as SignalId;

function servingWasRead(): Map<SignalId, SignalResult> {
  return new Map([
    [
      SERVING,
      observed(
        SERVING,
        { endpoints: [{ name: 'fraud-scoring', servedExternalModel: false, state: 'READY' }], truncated: false },
        1,
        { mode: 'complete' }
      ),
    ],
  ]);
}

/**
 * Every finding the framework produces from one signal.
 *
 * Close to the worst case on purpose. Everything but serving goes through the unmeasured path at
 * once, which is the only run in which all of them are visible together, and it is roughly what a
 * first scan against a locked-down workspace returns.
 */
function findingsWithNothingRead(): readonly Finding[] {
  const signals = servingWasRead();
  return catalogue.controls.map((control) => resolveControl(control, signals, registry.get(control.id)));
}

/** A saved scan carrying those findings, so the answers route reads them the way it reads a real one. */
async function storeHolding(findings: readonly Finding[]): Promise<InMemoryScanStore> {
  const store = new InMemoryScanStore();
  const at = new Date('2026-08-01T10:00:00.000Z');
  await store.save({
    id: 'nothing-read',
    startedAt: at,
    finishedAt: at,
    state: 'complete',
    stamp: {
      catalogueVersion: catalogue.version.version,
      catalogueFingerprint: catalogue.version.fingerprint,
      executionMode: 'on-behalf-of-user',
      actor: 'admin@example.com',
      scope: { description: 'this workspace' },
      lookbackDays: 30,
    },
    score: {
      pillars: [],
      counts: {
        pass: 0,
        fail: 0,
        partial: 0,
        unmeasurable: findings.length,
        'not-applicable': 0,
        'satisfied-by-architecture': 0,
      },
      scoredControls: 0,
      composition: { observed: 0, 'admin-collected': 0, attested: 0 },
      totalControls: findings.length,
    },
    findings,
    signals: [],
    estate: { assessed: [{ id: 'w1', name: 'prod', status: 'RUNNING' }], excluded: [] },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
  });
  return store;
}

async function answersFor(findings: readonly Finding[]): Promise<readonly { controlId: string; question: string }[]> {
  const store = await storeHolding(findings);
  const attestations = new InMemoryAttestationStore();
  const routes = express();
  routes.use(express.json());
  registerApi(routes, {
    catalogue,
    registry,
    runner: new ScanRunner({ catalogue, registry, store, attestations, measuredPillars: ['data-and-ai-governance'] }),
    store,
    attestations,
    host: 'http://127.0.0.1:1',
    // Never exercised here: this test reads the questions page, and reading is not gated.
    assessorGroup: 'waf-assessors',
    pillars: ['data-and-ai-governance'],
    collectorsFor: () => [],
  });

  const url = await servedAt(routes, servers);

  const response = await fetch(`${url}/api/attestations`);
  const body = (await response.json()) as { requirements: { controlId: string; question: string }[] };
  return body.requirements;
}

describe('the advice on a finding and the page it sends the reader to', () => {
  it('offers a slot for every requirement whose remedy tells the reader to answer it', async () => {
    const findings = findingsWithNothingRead();
    const promised = findings.filter((finding) => finding.remedy?.kind === 'attest').map((finding) => finding.controlId);
    const offered = new Set((await answersFor(findings)).map((requirement) => requirement.controlId));

    // Asserted, so the test cannot pass by finding nothing to check.
    expect(promised.length).toBeGreaterThan(50);
    expect(promised.filter((controlId) => !offered.has(controlId))).toEqual([]);
  });

  it('asks a real question about each one, rather than naming it and hoping', async () => {
    // A slot alone is not the promise kept. The route has a last-resort branch that builds a
    // question out of the title, and a requirement reaching this page through the runtime path
    // would land on it — which is how the reader gets asked "Protect model serving endpoints. How
    // well does this describe your estate?" and answers something unfalsifiable into the score.
    const findings = findingsWithNothingRead();
    const promised = new Set(
      findings.filter((finding) => finding.remedy?.kind === 'attest').map((finding) => finding.controlId)
    );
    const asked = (await answersFor(findings)).filter((requirement) => promised.has(requirement.controlId));

    const generic = asked.filter((requirement) => /How well does this describe your estate\?$/u.test(requirement.question));
    expect(generic.map((requirement) => requirement.controlId)).toEqual([]);
  });

  it('offers one for a requirement only the resolver knows is out of reach', async () => {
    // The specific case, pinned by id. The invariant above would keep passing if SCP-03-07 stopped
    // resolving at all, and "no requirement makes a promise it cannot keep" is also true of a
    // framework that has stopped asking the question.
    const findings = findingsWithNothingRead();
    const endpoints = findings.find((finding) => finding.controlId === 'SCP-03-07');

    // The state the fixture exists to produce: the census answered, so the requirement is known to
    // apply, and the protection in front of the endpoints is still beyond any install.
    expect(endpoints?.unmeasured).toBe('unreachable');
    expect(endpoints?.remedy?.kind).toBe('attest');
    expect((await answersFor(findings)).map((requirement) => requirement.controlId)).toContain('SCP-03-07');
  });
});
