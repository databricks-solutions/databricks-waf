// Serving the methodology, over the catalogue this build actually ships.
//
// The real catalogue rather than a fixture, deliberately. What this route serves is the shipped
// methodology, and the failures worth catching are properties of that: a requirement the record holds
// and the app has stopped asking about, a field the record writes in a shape a component cannot
// render, a version list that reads oldest-first on a page whose top row should be the release the
// customer is on. A fixture would assert the presenter maps fields, which typechecking already does.
//
// The one thing asserted against a fixture is the span refusal, because the shipped changelog has a
// single entry and cannot exercise a composition.

import express from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { InMemoryScanStore } from '../scan/store.js';
import { runIdentity } from '../scan/identity.js';
import { ScanRunner } from '../scan/runner.js';
import { registerApi } from './routes.js';
import type { CatalogueSpanPayload, MethodologyPayload } from '../../shared/api/contract.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();
const servers: Server[] = [];

afterAll(() => closeServed(servers));

async function serving(): Promise<string> {
  const store = new InMemoryScanStore();
  const routes = express();
  routes.use(express.json());
  registerApi(routes, {
    catalogue,
    registry,
    runner: new ScanRunner({ catalogue, registry, store, measuredPillars: ['operational-excellence'] }),
    store,
    host: 'http://127.0.0.1:1',
    // Never exercised: the methodology is the same for every install, and reading it is not gated.
    assessorGroup: 'waf-assessors',
    pillars: ['operational-excellence'],
    collectorsFor: () => [],
  });

  return servedAt(routes, servers);
}

async function methodology(): Promise<MethodologyPayload> {
  const response = await fetch(`${await serving()}/api/methodology`);
  expect(response.status).toBe(200);
  return (await response.json()) as MethodologyPayload;
}

describe('the methodology this build measures against', () => {
  it('serves the public release separately from technical catalogue provenance', async () => {
    const payload = await methodology();

    expect(payload.release.publicVersion).toBe(1);
    expect(payload.release.state).toBe('released');
    expect(payload.release.effectiveDate).toBe('2026-08-28');
    expect(payload.release.releaseCommit).toBe('60ff57fa7ceb2ca844532376230c0769b9f304ba');
    expect(payload.release.approvedBy).toBe('Al Thrussell (product owner)');
    expect(payload.release.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.technical.catalogueRevision).toBe(catalogue.version.version);
    expect(payload.technical.catalogueFingerprint).toBe(catalogue.version.fingerprint);
    expect(payload.unavailable).toBeUndefined();
  });

  it('serves every requirement the app scores, and no more', async () => {
    const payload = await methodology();

    expect(payload.requirements).toHaveLength(catalogue.controls.length);
    // Both directions empty is the claim: the record describes this build's catalogue exactly. CI
    // enforces it with `catalogue:version --check`, and this holds the route to reporting it.
    expect(payload.missing).toEqual([]);
    expect(payload.unrecorded).toEqual([]);
    expect(payload.requirements.every((one) => one.drifted == null)).toBe(true);
  });

  it('counts the scored units, which is fewer than the requirements', async () => {
    const payload = await methodology();

    // A score is out of the folded count, not the row count, because a requirement written down in two
    // pillars is one thing to fix. A page that showed the row count would disagree with every score.
    expect(payload.scoredUnits).toBeLessThan(payload.requirements.length);
    expect(payload.scoredUnits).toBe(catalogue.controls.length - collapsed());
  });

  it('serves the fields that decide how a requirement scores, and not its prose', async () => {
    const payload = await methodology();
    const one = payload.requirements.find((requirement) => requirement.thresholds != null);

    expect(one).toBeDefined();
    expect(one?.severity).not.toBe('');
    expect(one?.provenance).not.toBe('');
    expect(Object.values(one?.thresholds ?? {}).every((value) => value != null)).toBe(true);
    // Not a second copy of the catalogue: the prose, the remediation and the references stay on
    // `/api/catalogue`, and a reader comparing two versions does not need them.
    expect(one).not.toHaveProperty('criteria');
    expect(one).not.toHaveProperty('remediation');
  });

  it('serves the preconditions that exclude a requirement, as the methodology sets them', async () => {
    const payload = await methodology();
    const excluded = payload.requirements.filter((one) => one.preconditions.length > 0);

    expect(excluded.length).toBeGreaterThan(0);
    // The rule, not a customer's claim. This is why a comparable score can leave a requirement out at
    // all, so a reader has to be able to see the condition rather than take the exclusion on trust.
    expect(excluded[0]?.preconditions[0]?.signal).toMatch(/:/);
    expect(['not-applicable', 'satisfied-by-architecture']).toContain(excluded[0]?.preconditions[0]?.outcome);
  });

  it('serves the weighting a run records, so a reader can tell whether it still applies', async () => {
    const payload = await methodology();

    // The identifier a run stamps as its methodology axis. Matching it is how a reader knows the score
    // in front of them was computed by the weighting described here rather than by a superseded one.
    expect(payload.scoring.digest).toBe(runIdentity([]).methodology.id);
    expect(payload.scoring.severityWeight.critical).toBeGreaterThan(payload.scoring.severityWeight.low);
    expect(payload.scoring.credit.pass).toBe(1);
    expect(payload.scoring.credit.fail).toBe(0);
    // Null, not zero, and the page has to be able to say why: an outcome left out of the average is a
    // requirement the score is not out of, which is a different claim from one that earned nothing.
    expect(payload.scoring.credit['not-applicable']).toBeNull();
    expect(payload.scoring.credit.unmeasurable).toBeNull();
  });

  it('labels development history as technical revisions, newest first', async () => {
    const payload = await methodology();

    expect(payload.technical.revisions.length).toBeGreaterThan(0);
    expect(payload.technical.revisions[0]?.revision).toBe(catalogue.version.version);
    // The changelog holds entries oldest first because that is the order a span walks them in. A page
    // that inherited that order would put the oldest release at the top of the list.
    expect(payload.technical.revisions.map((one) => Number(one.revision))).toEqual(
      [...payload.technical.revisions.map((one) => Number(one.revision))].sort((a, b) => b - a)
    );
  });
});

describe('what separates two versions', () => {
  it('refuses a span across a version this build has no record of', async () => {
    const url = await serving();
    const response = await fetch(`${url}/api/methodology/catalogue-span?from=1&to=${catalogue.version.version}`);
    const span = (await response.json()) as CatalogueSpanPayload;

    // The shipped changelog starts at the version this build is on, so everything before it is
    // undescribed. The refusal names the gap rather than composing an empty diff, which would read as
    // "nothing changed" across releases nobody wrote down.
    expect(response.status).toBe(200);
    expect(span.describable).toBe(false);
    expect(span.why).toMatch(/no record|before this app wrote/);
    expect(span.added).toEqual([]);
  });

  it('says a version is identical to itself without consulting the record', async () => {
    const url = await serving();
    const version = catalogue.version.version;
    const span = (await (
      await fetch(`${url}/api/methodology/catalogue-span?from=${version}&to=${version}`)
    ).json()) as CatalogueSpanPayload;

    expect(span.describable).toBe(true);
    expect(span.added).toEqual([]);
    expect(span.removed).toEqual([]);
    expect(span.changed).toEqual([]);
  });

  it('refuses to guess when only one version is named', async () => {
    const url = await serving();
    const response = await fetch(`${url}/api/methodology/catalogue-span?to=9`);

    // No default for the other end. "Since whichever version you happen to be on" is a different
    // claim from the one the caller asked about, and the two differ on exactly the installs that are
    // behind.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: string }).error).toBe('no-versions');
  });
});

/** How many requirements the alias groups fold away, counted the way the bump counts it. */
function collapsed(): number {
  let folded = 0;
  for (const group of catalogue.aliasGroups.values()) folded += group.length - 1;
  return folded;
}
