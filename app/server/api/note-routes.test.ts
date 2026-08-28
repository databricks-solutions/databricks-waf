// Serving notes, and writing them.
//
// What a note is and what it refuses is tested in `note/note.test.ts`, and both stores in
// `note/store.test.ts`. What is worth holding here is what only a route can get wrong, and there are
// four of those.
//
// The subject comes from the path and nowhere else, so a request cannot have the note stored about one
// requirement and the trail naming another. The trail's target is the subject rather than the note, so
// one search answers "everything anybody recorded about DG-1". There is no route that edits or removes
// a note, which is the record's guarantee expressed as a surface rather than as a domain rule. And a
// note about something this install does not have is refused, because a note nothing can place is a
// note nobody reads again.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { NoteCountsPayload, NotePayload, NoteThreadPayload, NoteThreadsPayload } from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { InMemoryNoteStore, type NoteStore } from '../note/store.js';
import type { NoteSubject } from '../note/note.js';
import { registerNoteRoutes } from './note-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const NOW = new Date('2026-08-04T09:00:00.000Z');
const BODY = 'Both clusters this fails on are in the lab account, which closes in November.';

/** What this build pretends to have, so a note can be refused a subject that is not there. */
const PRESENT: readonly NoteSubject[] = [
  { kind: 'control', id: 'DG-01-01' },
  { kind: 'pillar', id: 'data-and-ai-governance' },
  { kind: 'run', id: 'run-1' },
];

class Refused extends Error {}

interface Harness {
  readonly base: string;
  readonly store: NoteStore;
  readonly audit: AuditLog;
}

async function serve(
  over: {
    readonly omitStore?: boolean;
    readonly permit?: boolean;
    readonly actor?: string;
    /** Drops the subject check, as a build with no catalogue and no runs has to. */
    readonly anySubject?: boolean;
  } = {}
): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const store = new InMemoryNoteStore();
  const audit = new InMemoryAuditLog();
  const recorder = new AuditRecorder(audit);
  let minted = 0;

  registerNoteRoutes(app, {
    ...(over.omitStore === true ? {} : { notes: store }),
    noteStorage: 'Kept in the waf schema of the bound database.',
    ...(over.anySubject === true
      ? {}
      : {
          knownSubject: (subject) =>
            Promise.resolve(PRESENT.some((one) => one.kind === subject.kind && one.id === subject.id)),
        }),
    now: () => NOW,
    newId: () => `note-${String((minted += 1))}`,
    // The real recorder over an in-memory log rather than a stub act, for the reason the improve routes
    // give: the routes are the only place the events are composed, so a fake act would leave nothing
    // checking that a note records what it was about.
    permitted: (
      _request: Request,
      response: Response,
      action: AuditAction,
      context?: { readonly target?: AuditTarget }
    ) =>
      over.permit === false
        ? Promise.reject(new Refused('not permitted'))
        : Promise.resolve({
            actor: over.actor ?? 'priya@example.com',
            act: closedWhenAnswered(
              recorder.begin(
                action,
                { actor: over.actor ?? 'priya@example.com', executionMode: 'on-behalf-of-user' },
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
  });

  const base = await servedAt(app, servers);
  return { base, store, audit };
}

async function send(
  base: string,
  path: string,
  body?: unknown,
  method = 'POST'
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

async function read<T>(base: string, path: string): Promise<T> {
  return (await (await fetch(`${base}${path}`)).json()) as T;
}

/**
 * Every act the routes recorded, oldest first, as act, outcome, target and reason.
 *
 * Both the target and the reason, unlike the improve routes' version of this helper, because every
 * note event has a target — the thing the note is about — and a refusal is only visible in the reason.
 */
async function acts(
  audit: AuditLog
): Promise<readonly (readonly [string, string, string | undefined, string | undefined])[]> {
  const { events } = await audit.search();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => [event.action, event.outcome, event.target?.id, event.reason] as const);
}

describe('writing a note', () => {
  it('stores it against the subject in the path and records the act against the same thing', async () => {
    const { base, audit } = await serve();

    const { status, body } = await send(base, '/api/notes/control/DG-01-01', { body: BODY });
    const note = body as NotePayload;

    expect(status).toBe(201);
    expect(note).toMatchObject({
      id: 'note-1',
      subject: { kind: 'control', id: 'DG-01-01' },
      body: BODY,
      by: 'priya@example.com',
      at: NOW.toISOString(),
    });
    // The subject, not the note. An auditor asking what was recorded about DG-01-01 finds this row
    // beside the attestations and decisions about it.
    await expect(acts(audit)).resolves.toEqual([['note.write', 'performed', 'DG-01-01', undefined]]);
  });

  it('ignores a subject in the body, so the note and the trail cannot be about different things', async () => {
    const { base, audit } = await serve();

    const { body } = await send(base, '/api/notes/control/DG-01-01', {
      body: BODY,
      subject: { kind: 'control', id: 'SEC-99' },
    });

    expect((body as NotePayload).subject).toEqual({ kind: 'control', id: 'DG-01-01' });
    await expect(acts(audit)).resolves.toEqual([['note.write', 'performed', 'DG-01-01', undefined]]);
  });

  it('records a note about a run against the run, which the trail calls a scan', async () => {
    const { base, audit } = await serve();

    await send(base, '/api/notes/run/run-1', { body: 'This ran during the migration, so the compute half is noise.' });

    await expect(acts(audit)).resolves.toEqual([['note.write', 'performed', 'run-1', undefined]]);
  });

  it('takes the run being read from the query string, for a note about a requirement', async () => {
    const { base } = await serve();

    const { body } = await send(base, '/api/notes/control/DG-01-01?observedIn=run-1', { body: BODY });

    expect((body as NotePayload).observedIn).toBe('run-1');
  });

  it('lets the body name a different run than the page the writer was on', async () => {
    const { base } = await serve();

    const { body } = await send(base, '/api/notes/control/DG-01-01?observedIn=run-1', {
      body: BODY,
      observedIn: 'run-0',
    });

    expect((body as NotePayload).observedIn).toBe('run-0');
  });

  it('refuses a note about something this installation does not have, and says the attempt failed', async () => {
    const { base, audit } = await serve();

    const { status, body } = await send(base, '/api/notes/control/NOPE-01', { body: BODY });

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'unknown-subject' });
    await expect(acts(audit)).resolves.toEqual([['note.write', 'failed', 'NOPE-01', 'unknown-subject']]);
  });

  it('refuses a kind that is not one of the three, before anything is recorded', async () => {
    const { base, audit } = await serve();

    const { status, body } = await send(base, '/api/notes/pilar/data-and-ai-governance', { body: BODY });

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'unknown-subject' });
    // Nothing in the trail: there was no act to attempt, because the address does not name a subject.
    await expect(acts(audit)).resolves.toEqual([]);
  });

  it('refuses a note too short to be worth a line, and the trail says so', async () => {
    const { base, audit } = await serve();

    const { status, body } = await send(base, '/api/notes/control/DG-01-01', { body: 'ok' });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid-note' });
    await expect(acts(audit)).resolves.toEqual([['note.write', 'failed', 'DG-01-01', 'InvalidNoteError']]);
  });

  it('says there is nowhere to keep a note rather than accepting one it would lose', async () => {
    const { base } = await serve({ omitStore: true });

    const { status, body } = await send(base, '/api/notes/control/DG-01-01', { body: BODY });

    expect(status).toBe(503);
    expect(body).toMatchObject({ error: 'notes-unavailable' });
  });

  it('turns away a caller the gate refused, and writes nothing', async () => {
    const { base, store } = await serve({ permit: false });

    const { status } = await send(base, '/api/notes/control/DG-01-01', { body: BODY });

    expect(status).toBe(403);
    expect(await store.for({ kind: 'control', id: 'DG-01-01' })).toEqual([]);
  });
});

describe('correcting a note', () => {
  it('is another note naming the one it corrects, and both stay readable', async () => {
    const { base } = await serve();
    await send(base, '/api/notes/control/DG-01-01', { body: BODY });

    const { status } = await send(base, '/api/notes/control/DG-01-01', {
      body: 'The account closes in December, not November.',
      corrects: 'note-1',
    });

    expect(status).toBe(201);
    const thread = await read<NoteThreadPayload>(base, '/api/notes/control/DG-01-01');
    expect(thread.notes.map((note) => note.id)).toEqual(['note-1', 'note-2']);
    expect(thread.notes[1]?.corrects).toBe('note-1');
  });

  it('refuses a correction of a note filed against something else', async () => {
    const { base } = await serve();
    await send(base, '/api/notes/pillar/data-and-ai-governance', { body: BODY });

    const { status, body } = await send(base, '/api/notes/control/DG-01-01', {
      body: 'The account closes in December, not November.',
      corrects: 'note-1',
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid-note' });
  });

  it('is the same act in the trail, because a correction is a note rather than a change to one', async () => {
    const { base, audit } = await serve();
    await send(base, '/api/notes/control/DG-01-01', { body: BODY });
    await send(base, '/api/notes/control/DG-01-01', { body: 'Closes in December, not November.', corrects: 'note-1' });

    await expect(acts(audit)).resolves.toEqual([
      ['note.write', 'performed', 'DG-01-01', undefined],
      ['note.write', 'performed', 'DG-01-01', undefined],
    ]);
  });
});

describe('there is no way to unsay one', () => {
  it('has no route that replaces a note', async () => {
    const { base } = await serve();
    await send(base, '/api/notes/control/DG-01-01', { body: BODY });

    // Raw rather than through `send`, because express answers an unrouted method with an HTML page —
    // which is itself the evidence: nothing in this module composed that response.
    const response = await fetch(`${base}/api/notes/control/note-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Something else entirely.' }),
    });

    expect(response.status).toBe(404);
  });

  it('has no route that removes one', async () => {
    const { base, store } = await serve();
    await send(base, '/api/notes/control/DG-01-01', { body: BODY });

    const response = await fetch(`${base}/api/notes/control/DG-01-01`, { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect(await store.for({ kind: 'control', id: 'DG-01-01' })).toHaveLength(1);
  });
});

describe('reading a thread', () => {
  it('is ungated, because a review is a read', async () => {
    const { base } = await serve({ permit: false });

    const thread = await read<NoteThreadPayload>(base, '/api/notes/control/DG-01-01');

    expect(thread.notes).toEqual([]);
    expect(thread.subject).toEqual({ kind: 'control', id: 'DG-01-01' });
  });

  it('carries the floors the server enforces, so a form does not keep a second copy of them', async () => {
    const { base } = await serve();

    const thread = await read<NoteThreadPayload>(base, '/api/notes/control/DG-01-01');

    expect(thread.minNote).toBe(10);
    expect(thread.maxNote).toBe(4000);
  });

  it('reads oldest first, whatever order the notes arrived in', async () => {
    const { base } = await serve();
    await send(base, '/api/notes/control/DG-01-01', { body: BODY });
    await send(base, '/api/notes/control/DG-01-01', { body: 'A second observation, later in the day.' });

    const thread = await read<NoteThreadPayload>(base, '/api/notes/control/DG-01-01');

    expect(thread.notes.map((note) => note.id)).toEqual(['note-1', 'note-2']);
  });

  it('says a thread is not being kept rather than showing an empty one as if it were', async () => {
    const { base } = await serve({ omitStore: true });

    const thread = await read<NoteThreadPayload>(base, '/api/notes/control/DG-01-01');

    expect(thread.durable).toBe(false);
    expect(thread.durabilityNote).toContain('nowhere to put one');
  });

  it('warns when notes are kept somewhere a restart empties', async () => {
    const { base } = await serve();

    const thread = await read<NoteThreadPayload>(base, '/api/notes/control/DG-01-01');

    expect(thread.durable).toBe(false);
    expect(thread.durabilityNote).toContain('waf schema');
  });
});

describe('reading every thread of one kind', () => {
  it('answers the threads that have notes and omits the rest', async () => {
    const { base } = await serve();
    await send(base, '/api/notes/control/DG-01-01', { body: BODY });
    await send(base, '/api/notes/pillar/data-and-ai-governance', { body: BODY });

    const payload = await read<NoteThreadsPayload>(base, '/api/notes/threads/control');

    expect(payload.kind).toBe('control');
    expect(payload.threads).toHaveLength(1);
    expect(payload.threads[0]?.subject).toEqual({ kind: 'control', id: 'DG-01-01' });
    expect(payload.threads[0]?.notes).toHaveLength(1);
  });

  it('refuses a kind it does not have', async () => {
    const { base } = await serve();

    const response = await send(base, '/api/notes/threads/pilar', undefined, 'GET');

    expect(response.status).toBe(404);
  });

  it('answers nothing rather than failing when notes are not being kept', async () => {
    const { base } = await serve({ omitStore: true });

    const payload = await read<NoteThreadsPayload>(base, '/api/notes/threads/control');

    expect(payload).toMatchObject({ kind: 'control', threads: [], durable: false });
  });
});

describe('counting threads', () => {
  it('answers how many notes each subject of one kind carries', async () => {
    const { base } = await serve();
    await send(base, '/api/notes/pillar/data-and-ai-governance', { body: BODY });
    await send(base, '/api/notes/pillar/data-and-ai-governance', { body: 'A second thing about this pillar.' });
    await send(base, '/api/notes/control/DG-01-01', { body: BODY });

    const counts = await read<NoteCountsPayload>(base, '/api/notes/pillar');

    expect(counts.counts).toEqual({ 'data-and-ai-governance': 2 });
  });

  it('refuses a kind it does not have, rather than reading it as a subject with no id', async () => {
    const { base } = await serve();

    const counts = await send(base, '/api/notes/pilar', undefined, 'GET');

    expect(counts.status).toBe(404);
  });

  it('answers nothing rather than failing when notes are not being kept', async () => {
    const { base } = await serve({ omitStore: true });

    const counts = await read<NoteCountsPayload>(base, '/api/notes/run');

    expect(counts).toMatchObject({ counts: {}, durable: false });
  });
});

describe('an installation that cannot check its subjects', () => {
  it('accepts a note about anything, rather than refusing every one for a reason about itself', async () => {
    const { base } = await serve({ anySubject: true });

    const { status } = await send(base, '/api/notes/control/ANYTHING-01', { body: BODY });

    expect(status).toBe(201);
  });
});
