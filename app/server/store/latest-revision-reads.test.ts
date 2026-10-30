// The reads that take the newest revision of each record, held to one rule: Postgres chooses, and the
// answer is the one the in-memory store gives.
//
// Four stores kept every revision of everything and reduced it here, so what a read cost grew with the
// retention period rather than with the records. Each now asks the database for the newest revision, or
// the newest stamp, and reads more only where the choice needs it: a record whose newest revision will
// not parse, or a requirement whose newest stamp is shared.
//
// This file is what the access-path audit finding names. Each case runs one history through the
// in-memory store and the Postgres one and asks both the same question, and then looks at what the
// Postgres one sent, because an answer that is right for the wrong reason — every row read, then reduced
// — is the defect and cannot be seen from the answer.

import { describe, expect, it } from 'vitest';
import { PostgresRiskStore } from '../accept/postgres-store.js';
import { revoked as revokedRisk, type AcceptedRisk } from '../accept/risk.js';
import { InMemoryRiskStore } from '../accept/store.js';
import { PostgresApplicabilityStore } from '../apply/postgres-store.js';
import { revoked as revokedDecision, type ApplicabilityDecision } from '../apply/applicability.js';
import { InMemoryApplicabilityStore } from '../apply/store.js';
import { PostgresAttestationStore } from '../attest/postgres-store.js';
import type { Attestation } from '../attest/attestation.js';
import { InMemoryAttestationStore } from '../attest/store.js';
import { define, revise, type Draft } from '../define/definition.js';
import { PostgresDefinitionStore } from '../define/postgres-store.js';
import { InMemoryDefinitionStore } from '../define/store.js';
import { FakePostgres } from './postgres-fake.js';

const AT = new Date('2026-04-10T09:00:00.000Z');
const LATER = new Date('2026-04-20T09:00:00.000Z');
const EXPIRES = new Date('2026-12-01T00:00:00.000Z');
const hours = (n: number): Date => new Date(AT.getTime() + n * 3_600_000);

const byId = <T extends { readonly id: string }>(records: readonly T[]): T[] =>
  [...records].sort((a, b) => a.id.localeCompare(b.id));

/** What a read sent that was not bounded by a key or by the newest of something. */
const wholeHistory = (statements: readonly string[]): string[] =>
  statements.filter((sql) => /order by (revision asc|\w+_at desc)$/.test(sql) && !/ where /.test(sql));

function risk(id: string, controlId: string, definitionId: string | undefined, recordedAt: Date): AcceptedRisk {
  return {
    id,
    controlId,
    ordinal: 1,
    reason: 'The review is manual until the platform team finishes the rota tooling next quarter.',
    compensatingControl: 'The two workspaces are read-only outside the platform group, checked weekly.',
    residual: 'low',
    owner: 'platform-engineering',
    effectiveFrom: AT,
    expiresAt: EXPIRES,
    recordedBy: 'ana@example.com',
    recordedAt,
    ...(definitionId != null ? { definitionId } : {}),
  };
}

function decision(
  id: string,
  controlId: string,
  definitionId: string | undefined,
  recordedAt: Date
): ApplicabilityDecision {
  return {
    id,
    controlId,
    lever: 'not-applicable',
    ordinal: 1,
    reason: 'This estate runs no external sharing, so the requirement is about a thing it does not have.',
    owner: 'platform-engineering',
    effectiveFrom: AT,
    expiresAt: EXPIRES,
    recordedBy: 'ana@example.com',
    recordedAt,
    ...(definitionId != null ? { definitionId } : {}),
  };
}

function attestation(id: string, controlId: string, attestedAt: Date, over: Partial<Attestation> = {}): Attestation {
  return {
    id,
    controlId,
    answer: 'met',
    statement: 'A test wrote this, and it is long enough to be a real statement.',
    owner: 'platform-team@example.com',
    attestedBy: 'someone@example.com',
    attestedAt,
    reviewBy: new Date(attestedAt.getTime() + 86_400_000),
    ...over,
  };
}

describe('the access paths that take the newest revision in SQL', () => {
  it('reads accepted risks at their newest revision in SQL, and answers as the in-memory store does', async () => {
    const db = new FakePostgres({ keys: { accepted_risks: ['id', 'revision'] } });
    const errors: string[] = [];
    const postgres = new PostgresRiskStore({ db, onError: (operation) => errors.push(operation) });
    const memory = new InMemoryRiskStore();

    const written = [
      risk('r1', 'GOV-01', 'def-a', hours(1)),
      risk('r2', 'GOV-02', 'def-a', hours(2)),
      risk('r3', 'GOV-03', 'def-b', hours(3)),
      risk('r4', 'GOV-04', undefined, hours(4)),
    ];
    for (const one of written) {
      await postgres.record(one);
      await memory.record(one);
    }
    const ended = revokedRisk(written[0], 'raj@example.com', 'The grant was removed.', LATER);
    await postgres.revoke(ended);
    await memory.revoke(ended);
    db.statements.length = 0;

    for (const scope of [undefined, 'def-a', 'def-b', null] as const) {
      expect(byId(await postgres.all(scope)), `scope ${String(scope)}`).toEqual(byId(await memory.all(scope)));
    }
    expect(wholeHistory(db.statements)).toEqual([]);
    expect(db.statements.every((sql) => sql.startsWith('select distinct on (id) id, body from'))).toBe(true);

    // The newest revision of one acceptance cannot be read. It goes on reading as standing, which is
    // what it was before the revocation, and only that acceptance is asked for again.
    db.seed('accepted_risks', { id: 'r2', revision: 1, control_id: 'GOV-02', definition_id: 'def-a', body: { id: 'r2' } });
    db.statements.length = 0;

    expect(byId(await postgres.all('def-a'))).toEqual(byId(await memory.all('def-a')));
    expect(db.statements).toEqual([
      'select distinct on (id) id, body from waf.accepted_risks where definition_id = $1 order by id, revision desc',
      'select id, body from waf.accepted_risks where id = any($1::text[]) and definition_id = $2 order by revision desc',
    ]);
    expect(errors).toEqual(['read accepted risks']);
  });

  it('reads applicability decisions at their newest revision in SQL, and answers as the in-memory store does', async () => {
    const db = new FakePostgres({ keys: { applicability_decisions: ['id', 'revision'] } });
    const errors: string[] = [];
    const postgres = new PostgresApplicabilityStore({ db, onError: (operation) => errors.push(operation) });
    const memory = new InMemoryApplicabilityStore();

    const written = [
      decision('d1', 'GOV-01', 'def-a', hours(1)),
      decision('d2', 'GOV-02', 'def-a', hours(2)),
      decision('d3', 'GOV-03', undefined, hours(3)),
    ];
    for (const one of written) {
      await postgres.record(one);
      await memory.record(one);
    }
    const ended = revokedDecision(written[0], 'raj@example.com', 'Sharing was turned on.', LATER);
    await postgres.revoke(ended);
    await memory.revoke(ended);
    db.statements.length = 0;

    for (const scope of [undefined, 'def-a', null] as const) {
      expect(byId(await postgres.all(scope)), `scope ${String(scope)}`).toEqual(byId(await memory.all(scope)));
    }
    expect(wholeHistory(db.statements)).toEqual([]);
    expect(db.statements.every((sql) => sql.startsWith('select distinct on (id) id, body from'))).toBe(true);

    db.seed('applicability_decisions', { id: 'd2', revision: 1, control_id: 'GOV-02', definition_id: 'def-a', body: { id: 'd2' } });
    db.statements.length = 0;

    expect(byId(await postgres.all('def-a'))).toEqual(byId(await memory.all('def-a')));
    expect(db.statements).toEqual([
      'select distinct on (id) id, body from waf.applicability_decisions where definition_id = $1 order by id, revision desc',
      'select id, body from waf.applicability_decisions where id = any($1::text[]) and definition_id = $2 order by revision desc',
    ]);
    expect(errors).toEqual(['read applicability decisions']);
  });

  it('reads the newest event of each requirement in SQL, settling a same-millisecond supersession as the in-memory store does', async () => {
    const db = new FakePostgres();
    const errors: string[] = [];
    const postgres = new PostgresAttestationStore({ db, onError: (operation) => errors.push(operation) });
    const memory = new InMemoryAttestationStore();

    const same = hours(5);
    const written = [
      // One stamp, and the id of the record that supersedes the other sorts first, so only the chain
      // can put it on top.
      attestation('z-first', 'GOV-01', same),
      attestation('a-second', 'GOV-01', same, { supersedes: 'z-first' }),
      // A single newest record above an older one.
      attestation('older', 'GOV-02', hours(1)),
      attestation('newer', 'GOV-02', hours(6)),
      // A chain that runs through a record older than the two it joins.
      attestation('a', 'GOV-03', same),
      attestation('b', 'GOV-03', hours(1), { supersedes: 'a' }),
      attestation('c', 'GOV-03', same, { supersedes: 'b' }),
      // Another assessment's, newer than any of the above, which must not decide this one's newest.
      attestation('elsewhere', 'GOV-01', hours(9), { definitionId: 'def-b' }),
    ];
    for (const one of written) {
      await postgres.record(one);
      await memory.record(one);
    }
    db.statements.length = 0;

    for (const scope of [undefined, null, 'def-b'] as const) {
      expect(byId(await postgres.current(scope)), `scope ${String(scope)}`).toEqual(byId(await memory.current(scope)));
    }
    const current = new Map((await postgres.current(null)).map((one) => [one.controlId, one.id]));
    expect(current.get('GOV-01')).toBe('a-second');
    expect(current.get('GOV-02')).toBe('newer');
    expect(current.get('GOV-03')).toBe('c');
    expect(wholeHistory(db.statements)).toEqual([]);

    // The newest record of one requirement cannot be read: the one before it stands in.
    db.seed('attestations', { id: 'broken', control_id: 'GOV-02', attested_at: hours(8), body: { id: 'broken' } });
    db.statements.length = 0;

    expect(byId(await postgres.current(null))).toEqual(byId(await memory.current(null)));
    expect(errors).toEqual(['read every attestation']);
  });

  it('reads one assessment definition by its id, and answers as the in-memory store and the full read do', async () => {
    const db = new FakePostgres({ keys: { assessment_definition_versions: ['definition_id', 'version'] } });
    const postgres = new PostgresDefinitionStore({ db: { ...db, query: db.query.bind(db), end: db.end.bind(db) } });
    const memory = new InMemoryDefinitionStore();
    const draft: Draft = {
      measurement: { scope: { kind: 'selected', workspaceIds: ['w1'] }, lookbackDays: 30 },
      attribution: { name: 'Q3 platform review', owners: ['alice@example.com'] },
    };
    for (const id of ['d1', 'd2', 'd3']) {
      const first = define(draft, id, AT, 'alice@example.com');
      const second = revise(first, { attribution: { name: `Renamed ${id}`, owners: [] } }, LATER, 'alice@example.com');
      await postgres.create(first);
      await memory.create(first);
      const added = second.versions[1];
      if (added == null) throw new Error('revise produced no second version');
      await postgres.appendVersion(id, added);
      await memory.appendVersion(id, added);
    }
    await postgres.archive('d2', LATER);
    await memory.archive('d2', LATER);
    const everything = await postgres.all();
    db.statements.length = 0;

    for (const id of ['d1', 'd2', 'd3']) {
      expect(await postgres.get(id), id).toEqual(await memory.get(id));
      expect(await postgres.get(id), id).toEqual(everything.find((one) => one.id === id));
    }
    expect(await postgres.get('missing')).toBeUndefined();
    // Two statements per read, each on the one id, and never the unbounded read of every definition.
    expect(db.statements.filter((sql) => !sql.includes(' where '))).toEqual([]);
  });
});
