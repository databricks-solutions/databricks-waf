// Reading the health of what this app depends on.
//
// The distinctions worth holding here are the ones an operator acts on differently, and they are all
// between states that a coarser model would collapse. `unknown` against `answering`, because a
// warehouse binding nothing has used yet is the commonest way for this to be wrong and reporting it
// as healthy would be wrong for exactly as long as it mattered. `unknown` against `unbound`, because
// "I cannot tell" and "there is nothing there" send somebody to different places. `degraded` against
// `silent`, because a warehouse that refused half the statements is a grant problem and one that did
// not answer is a binding problem.

import { describe, expect, it } from 'vitest';
import { readHealth, type Health, type Dependency, type Reading } from './health.js';

const NOW = new Date('2026-08-04T09:00:00.000Z');
const LAST_RUN = new Date('2026-08-03T22:00:00.000Z');

function reading(health: Health, dependency: Dependency): Reading {
  const found = health.readings.find((one) => one.dependency === dependency);
  if (found == null) throw new Error(`no reading for ${dependency}`);
  return found;
}

/** A wholly healthy install, so each test can spoil one thing and assert on that thing. */
function well() {
  return {
    now: () => NOW,
    pingDatabase: () => Promise.resolve(),
    durable: true,
    storage: 'Kept in the waf schema of the bound Lakebase database and survives restarts.',
    probeIdentity: () => Promise.resolve(),
    warehouseId: 'wh-1',
    lastRun: { at: LAST_RUN, statements: 24, refused: 0 },
    unrecorded: 0,
    auditDurable: true,
  };
}

describe('reading what this app depends on', () => {
  it('reports every dependency, so one page names the cause of every symptom', async () => {
    const health = await readHealth(well());

    expect(health.readings.map((one) => one.dependency)).toEqual(['warehouse', 'database', 'identity', 'audit-log']);
    expect(health.well).toBe(true);
    expect(health.at).toEqual(NOW);
  });

  it('says nothing to do about a dependency that is working', async () => {
    // An instruction beside a working dependency is an instruction somebody eventually follows.
    const health = await readHealth(well());

    for (const one of health.readings) expect(one).not.toHaveProperty('action');
  });
});

describe('the warehouse, which is never probed', () => {
  it('reports a binding nothing has used as unknown rather than as answering', async () => {
    // The commonest way for this to be wrong is an id naming a warehouse the app cannot reach, and
    // `answering` here would be wrong until somebody ran a scan — which is until it mattered.
    const health = await readHealth({ ...well(), lastRun: undefined });

    const warehouse = reading(health, 'warehouse');
    expect(warehouse.standing).toBe('unknown');
    expect(warehouse.detail).toContain('bill you for the answer');
    expect(warehouse.action).toContain('Run an assessment');
  });

  it('reports no binding as unbound, which is the one with a form to fill in', async () => {
    const health = await readHealth({ ...well(), warehouseId: undefined });

    expect(reading(health, 'warehouse').standing).toBe('unbound');
    expect(reading(health, 'warehouse').action).toContain('add a SQL warehouse resource');
  });

  it('reports statements refused as degraded, and points at the page that names them', async () => {
    const health = await readHealth({ ...well(), lastRun: { at: LAST_RUN, statements: 24, refused: 5 } });

    const warehouse = reading(health, 'warehouse');
    expect(warehouse.standing).toBe('degraded');
    expect(warehouse.detail).toContain('refused 5 of 24');
    expect(warehouse.action).toContain('Checks');
  });

  it('dates an observed reading to the observation rather than to now', async () => {
    // Otherwise "the warehouse is answering" as of this second would be a claim about last Tuesday.
    const health = await readHealth(well());

    const warehouse = reading(health, 'warehouse');
    expect(warehouse.provenance).toBe('observed');
    expect(warehouse.at).toEqual(LAST_RUN);
  });
});

describe('the database, which is', () => {
  it('names why it did not answer, because that decides whether to wait or to act', async () => {
    const health = await readHealth({
      ...well(),
      pingDatabase: () => Promise.reject(new Error('connection refused')),
    });

    const database = reading(health, 'database');
    expect(database.standing).toBe('silent');
    expect(database.detail).toContain('connection refused');
    expect(database.action).toContain('CAN_CONNECT_AND_CREATE');
    expect(health.well).toBe(false);
  });

  it('reports one line of a cause rather than a driver stack', async () => {
    const health = await readHealth({
      ...well(),
      pingDatabase: () => Promise.reject(new Error('timeout\n    at Client.connect (pg:1:1)')),
    });

    expect(reading(health, 'database').detail).toContain('timeout');
    expect(reading(health, 'database').detail).not.toContain('at Client.connect');
  });

  it('reports an answering database that keeps nothing as degraded rather than as healthy', async () => {
    const health = await readHealth({ ...well(), durable: false });

    expect(reading(health, 'database').standing).toBe('degraded');
    expect(reading(health, 'database').action).toContain('WAF_DEMO_NO_PERSISTENCE');
  });

  it('repeats the sentence the rest of the app uses, rather than a fifth wording of it', async () => {
    const health = await readHealth(well());

    expect(reading(health, 'database').detail).toBe(well().storage);
  });

  it('does not fail the whole reading when a probe throws', async () => {
    // A health endpoint that fails is the least useful thing this could be.
    await expect(
      readHealth({
        ...well(),
        pingDatabase: () => Promise.reject(new Error('down')),
        probeIdentity: () => Promise.reject(new Error('down')),
      })
    ).resolves.toMatchObject({ well: false });
  });
});

describe('the identity endpoint', () => {
  it('says the consequence rather than the outage, because reads keep working', async () => {
    const health = await readHealth({ ...well(), probeIdentity: () => Promise.reject(new Error('502 Bad Gateway')) });

    const identity = reading(health, 'identity');
    expect(identity.standing).toBe('silent');
    expect(identity.action).toContain('nobody can start a scan');
    expect(identity.action).toContain('Reading the assessment is unaffected');
  });

  it('is unknown rather than unbound when the request carried no token', async () => {
    const health = await readHealth({ ...well(), probeIdentity: undefined });

    // Not a fault: nothing was asked, so nothing failed, and the install is not unwell for it.
    expect(reading(health, 'identity').standing).toBe('unknown');
    expect(health.well).toBe(true);
  });
});

describe('what the app could not record', () => {
  it('reports the count, and that the acts happened even though the record did not', async () => {
    const health = await readHealth({ ...well(), unrecorded: 3 });

    const trail = reading(health, 'audit-log');
    expect(trail.standing).toBe('degraded');
    expect(trail.detail).toContain('3 actions could not be written');
    expect(trail.detail).toContain('A gap in the trail is not a gap in what was done');
    expect(health.unrecorded).toBe(3);
    expect(health.well).toBe(false);
  });

  it('says act rather than acts for one, because a status page is read by people', async () => {
    const health = await readHealth({ ...well(), unrecorded: 1 });

    expect(reading(health, 'audit-log').detail).toContain('1 action could not be written');
  });

  it('points at the database reading rather than repeating its diagnosis', async () => {
    const health = await readHealth({ ...well(), unrecorded: 2 });

    expect(reading(health, 'audit-log').action).toContain('the database reading above');
  });

  it('reports a trail held in memory as degraded before anything is lost', async () => {
    // Nothing is missing yet and everything will be, which is a thing to say now rather than after
    // the next deploy has taken it.
    const health = await readHealth({ ...well(), auditDurable: false });

    const trail = reading(health, 'audit-log');
    expect(trail.standing).toBe('degraded');
    expect(trail.detail).toContain('lost when this app restarts');
  });

  it('is unknown on an install that records no acts, rather than a clean bill', async () => {
    const health = await readHealth({ ...well(), unrecorded: undefined });

    expect(reading(health, 'audit-log').standing).toBe('unknown');
    expect(health.unrecorded).toBe(0);
    expect(health.well).toBe(true);
  });
});

describe('which posture the trail is kept under', () => {
  // A zero meaning "nothing was lost" and a zero meaning "nothing can be lost" are different facts,
  // and the auditor reading this page is reading it for the second. ADR 0046's amendment.
  it('says an act that cannot be recorded still stands, on the default', async () => {
    const trail = reading(await readHealth({ ...well(), unrecorded: 0 }), 'audit-log');

    expect(trail.standing).toBe('answering');
    expect(trail.detail).toContain('still stands');
  });

  it('says an act that cannot be recorded is refused, on a strict install', async () => {
    const trail = reading(await readHealth({ ...well(), unrecorded: 0, auditPosture: 'strict' }), 'audit-log');

    expect(trail.standing).toBe('answering');
    expect(trail.detail).toContain('refused rather than performed');
    // And what that does not promise, on the same line as the promise. A strict install told only the
    // first half would read a later count as the app contradicting itself.
    expect(trail.detail).toContain('after the trail has answered');
  });

  it('reads a strict count as what refusing before the act did not prevent', async () => {
    // On the default posture a count is the expected consequence of a database blip. On a strict one
    // it is evidence about the setting: something got past the check. Both ways that can happen are
    // named, because a reading that named one would be a diagnosis that is wrong half the time.
    const trail = reading(await readHealth({ ...well(), unrecorded: 2, auditPosture: 'strict' }), 'audit-log');

    expect(trail.standing).toBe('degraded');
    expect(trail.detail).toContain('failed after the trail had answered');
    expect(trail.detail).toContain('before the check could run');
  });

  it('does not tell a strict install that changes are being refused, which the count does not establish', async () => {
    // A trail that reads and will not write refuses nothing: every act on it is performed and lost,
    // exactly as on the default posture. An action asserting refusals would send an operator looking
    // for something that may not be happening — and the count cannot tell them which case they are in.
    const trail = reading(await readHealth({ ...well(), unrecorded: 2, auditPosture: 'strict' }), 'audit-log');

    expect(trail.action).not.toContain('are being refused');
    expect(trail.action).toContain('does not prevent this');
    // What is true, and conditional on the thing that would make it true.
    expect(trail.action).toContain('If the trail stops answering');
  });
});

describe('whether the install is well', () => {
  it('is not decided by a reading nothing could take', async () => {
    // Otherwise every demo install reports as broken, and the reader learns to ignore the flag on
    // the installs where it means something.
    const health = await readHealth({ now: () => NOW });

    expect(health.readings.every((one) => one.standing === 'unknown' || one.standing === 'unbound')).toBe(true);
    expect(health.well).toBe(true);
  });

  it('is false when anything is degraded, not only when something is silent', async () => {
    expect((await readHealth({ ...well(), unrecorded: 1 })).well).toBe(false);
    expect((await readHealth({ ...well(), lastRun: { at: LAST_RUN, statements: 4, refused: 1 } })).well).toBe(false);
  });
});
