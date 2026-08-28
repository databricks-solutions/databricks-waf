// The HTTP surface for notes.
//
// Four endpoints and no fifth, which is the record's guarantee expressed as routes: a thread, a
// count of threads, a collection of threads of one kind, and a write. There is no PUT and no DELETE,
// so a note cannot be edited or removed by anything that can reach this app over HTTP — not only by
// callers who go through the domain.
//
// Two decisions here that the domain does not make.
//
// **The subject comes from the path.** `/api/notes/control/DG-1` is the only place the subject can be
// named, so the note stored, the note validated, and the note the trail says was written are about the
// same thing. A subject in the body would let a request file a note against a requirement the writer
// was never looking at, with the audit row naming the one in the URL.
//
// **A note's audit target is what the note is about, not the note.** `everything anybody recorded
// about DG-1` is the question an auditor asks, and it is answered by one search across attestations,
// decisions and notes. The note's own id would answer a question nobody has: they do not know it, and
// if they did they would be reading the note.
//
// Reads are ungated, like the trail's and the catalogue's. A note is somebody's observation about the
// estate this app is already showing the reader, and a review is a read.

import type { Application, Request, Response } from 'express';
import type { NoteCountsPayload, NotePayload, NoteThreadPayload, NoteThreadsPayload } from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import {
  InvalidNoteError,
  MAX_NOTE,
  MIN_NOTE,
  NOTE_SUBJECT_KINDS,
  draftFrom,
  noted,
  type Note,
  type NoteSubject,
  type NoteSubjectKind,
} from '../note/note.js';
import type { NoteStore } from '../note/store.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { stamped } from '../store/assessment-scope.js';
import { assessmentOf } from './assessment-query.js';

export interface NoteRouteOptions {
  /** Absent means notes are not kept, and the routes say so rather than losing one. */
  readonly notes?: NoteStore;
  /** What this install does about keeping them, in the reader's terms. */
  readonly noteStorage?: string;
  /**
   * Whether there is something to write about.
   *
   * Absent means unchecked, which is what a build with no catalogue and no runs has to do. Present, it
   * refuses a note about a requirement the framework does not have — the same refusal an action makes,
   * and for the same reason: a note nothing can place is a note nobody reads again.
   */
  readonly knownSubject?: (subject: NoteSubject, scope: AssessmentScope) => Promise<boolean>;
  readonly permitted: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly target?: AuditTarget }
  ) => Promise<{ readonly actor: string; readonly act: Act }>;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const NO_STORE =
  'This installation is not keeping notes, so there is nowhere to put one. Bind a database and restart, ' +
  'and what people write down will survive a deploy.';

const NOT_DURABLE =
  'Notes are being kept in memory on this installation, so a restart loses every one of them. A note is ' +
  'an observation somebody made while reading something they will not read again — bind a database ' +
  'before relying on it.';

export function registerNoteRoutes(app: Application, options: NoteRouteOptions): void {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  /**
   * Every thread of one kind, so a page that lists many subjects can ask once.
   *
   * Registered before `/:kind/:id` because `/api/notes/threads/control` would otherwise be a thread
   * about a subject called `control` of kind `threads`. Empty threads are omitted.
   */
  app.get('/api/notes/threads/:kind', async (request, response) => {
    const store = options.notes;
    const kind = kindFrom(request.params.kind);
    if (kind == null) {
      response.status(404).json({ error: 'unknown-subject', message: unknownKind(request.params.kind) });
      return;
    }
    if (store == null) {
      response.json({
        kind,
        threads: [],
        durable: false,
        durabilityNote: NO_STORE,
        minNote: MIN_NOTE,
        maxNote: MAX_NOTE,
      } satisfies NoteThreadsPayload);
      return;
    }

    try {
      const notes = await store.ofKind(kind, assessmentOf(request));
      const bySubject = new Map<string, Note[]>();
      for (const note of notes) {
        const held = bySubject.get(note.subject.id) ?? [];
        held.push(note);
        bySubject.set(note.subject.id, held);
      }
      const payload: NoteThreadsPayload<Date> = {
        kind,
        threads: [...bySubject.entries()].map(([id, group]) => ({
          subject: { kind, id },
          notes: group.map(present),
          durable: store.durable,
          ...(store.durable ? {} : { durabilityNote: options.noteStorage ?? NOT_DURABLE }),
          minNote: MIN_NOTE,
          maxNote: MAX_NOTE,
        })),
        durable: store.durable,
        ...(store.durable ? {} : { durabilityNote: options.noteStorage ?? NOT_DURABLE }),
        minNote: MIN_NOTE,
        maxNote: MAX_NOTE,
      };
      response.json(dated(payload));
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /**
   * How many notes each subject of one kind carries.
   *
   * So a list of pillars can show which have been written about without fetching six threads of prose
   * nobody has opened. Registered before the thread route because `/api/notes/pillar` would otherwise
   * be read as a thread about a subject with no id.
   */
  app.get('/api/notes/:kind', async (request, response) => {
    const store = options.notes;
    const kind = kindFrom(request.params.kind);
    if (kind == null) {
      response.status(404).json({ error: 'unknown-subject', message: unknownKind(request.params.kind) });
      return;
    }
    if (store == null) {
      // 200 rather than 503, like the plans list: a page that failed to load says less than an empty
      // one that explains itself, and this one is decoration on a page that has other things to show.
      response.json({ counts: {}, durable: false, durabilityNote: NO_STORE } satisfies NoteCountsPayload);
      return;
    }

    try {
      const payload: NoteCountsPayload = {
        counts: await store.counts(kind, assessmentOf(request)),
        durable: store.durable,
        ...(store.durable ? {} : { durabilityNote: options.noteStorage ?? NOT_DURABLE }),
      };
      response.json(payload);
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /** One thread, oldest first, because a thread is read as a conversation. */
  app.get('/api/notes/:kind/:id', async (request, response) => {
    const store = options.notes;
    const subject = subjectFrom(request);
    if (subject == null) {
      response.status(404).json({ error: 'unknown-subject', message: unknownKind(request.params.kind) });
      return;
    }
    if (store == null) {
      response.json(emptyThread(subject, NO_STORE));
      return;
    }

    try {
      const notes = await store.for(subject, assessmentOf(request));
      const payload: NoteThreadPayload<Date> = {
        subject,
        notes: notes.map(present),
        durable: store.durable,
        ...(store.durable ? {} : { durabilityNote: options.noteStorage ?? NOT_DURABLE }),
        minNote: MIN_NOTE,
        maxNote: MAX_NOTE,
      };
      response.json(dated(payload));
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /**
   * Writes a note, or a correction of one, which is the same act.
   *
   * A correction names the note it corrects and both stay readable, so there is no route that replaces
   * a note and no audit action that claims one was changed.
   */
  app.post('/api/notes/:kind/:id', async (request, response) => {
    const store = options.notes;
    const subject = subjectFrom(request);
    if (subject == null) {
      response.status(404).json({ error: 'unknown-subject', message: unknownKind(request.params.kind) });
      return;
    }
    if (store == null) {
      response.status(503).json({ error: 'notes-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      // Before the body is read, like every other mutation: a note nobody is permitted to write should
      // not be validated first.
      const permission = await options.permitted(request, response, 'note.write', { target: targetOf(subject) });
      const { actor } = permission;
      act = permission.act;

      const scope = assessmentOf(request);
      if (options.knownSubject != null && !(await options.knownSubject(subject, scope))) {
        await refuse(
          response,
          act,
          404,
          'unknown-subject',
          `This installation has no ${subject.kind} called ${subject.id}, so a note about it is a note nothing can ` +
            'place. Check the address you came from.'
        );
        return;
      }

      // The thread is read before the note is drafted, because a correction has to name a note already
      // on this subject — see `draftFrom`. It is the read a writer needed anyway to know what they are
      // correcting.
      const existing = await store.for(subject, scope);
      const draft = draftFrom(request.body, subject, {
        existing,
        ...(observedFrom(request) != null ? { observedIn: observedFrom(request) } : {}),
      });
      const note = stamped(noted(draft, actor, newId(), now()), scope);
      await store.add(note);
      await act.performed(targetOf(subject));
      response.status(201).json(dated(present(note)));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });
}

/**
 * The subject a request is about, from the path only.
 *
 * Undefined for a kind that is not one of the three, rather than a note filed against
 * `pilar/data-governance` that nothing will ever read again.
 */
function subjectFrom(request: Request): NoteSubject | undefined {
  const kind = kindFrom(request.params.kind);
  const id = one(request.params.id);
  if (kind == null || id === '') return undefined;
  return { kind, id };
}

function kindFrom(raw: unknown): NoteSubjectKind | undefined {
  return NOTE_SUBJECT_KINDS.find((kind) => kind === raw);
}

/**
 * One path segment as a string.
 *
 * Express types both a path parameter and a query parameter as a string or an array of them, because a
 * repeated name is a legal URL. Two ids is not a subject, so anything else is the empty string and the
 * route refuses rather than guessing which one was meant.
 */
function one(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * The run the writer was reading, from the query string.
 *
 * A query parameter rather than a body field because it is context about where the writer was rather
 * than something they typed, and because the body may still name a different run — somebody writing
 * about last month's run from this month's page. `draftFrom` treats this as the default.
 */
function observedFrom(request: Request): string | undefined {
  const observed = one(request.query.observedIn);
  return observed === '' ? undefined : observed;
}

/** What the trail records: the thing the note is about. A run's audit kind is `scan`. */
function targetOf(subject: NoteSubject): AuditTarget {
  return { kind: subject.kind === 'run' ? 'scan' : subject.kind, id: subject.id };
}

function unknownKind(raw: string | undefined): string {
  return (
    `A note is about a run, a pillar or a requirement, and "${raw ?? ''}" is none of them. ` +
    'The address is /api/notes/{run|pillar|control}/{id}.'
  );
}

function emptyThread(subject: NoteSubject, why: string): NoteThreadPayload {
  return { subject, notes: [], durable: false, durabilityNote: why, minNote: MIN_NOTE, maxNote: MAX_NOTE };
}

/**
 * A note on the wire, field by field rather than spread.
 *
 * Written out for the reason the plan payload is: the two types are structurally identical today and
 * are allowed to stop being, and a spread would carry a new domain field onto the wire the day
 * somebody adds one.
 */
function present(note: Note): NotePayload<Date> {
  return {
    id: note.id,
    subject: note.subject,
    ...(note.observedIn != null ? { observedIn: note.observedIn } : {}),
    ...(note.corrects != null ? { corrects: note.corrects } : {}),
    body: note.body,
    by: note.by,
    at: note.at,
  };
}

/** Dates as ISO strings, in one traversal at the edge. The same helper the improve routes use. */
function dated<T>(payload: T): unknown {
  if (payload instanceof Date) return payload.toISOString();
  if (Array.isArray(payload)) return payload.map((entry: unknown) => dated(entry));
  if (payload != null && typeof payload === 'object') {
    return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, dated(value)]));
  }
  return payload;
}

async function refuse(response: Response, act: Act, status: number, error: string, message: string): Promise<void> {
  await act.failed(error);
  response.status(status).json({ error, message });
}

function respond(response: Response, cause: unknown, options: NoteRouteOptions): void {
  if (cause instanceof InvalidNoteError) {
    response.status(400).json({ error: 'invalid-note', message: cause.message });
    return;
  }
  options.respondToFailure(response, cause);
}
