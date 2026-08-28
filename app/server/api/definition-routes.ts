// The HTTP surface for assessment definitions.
//
// Its own module rather than more of `routes.ts`, which is long enough that the next reader of it
// deserves not to have another resource threaded through it.
//
// The permission gate and the failure responder arrive as functions rather than being imported.
// Partly that avoids an import cycle, since `routes.ts` registers these. Mostly it is what makes
// this file testable: a route whose gate is injected can be exercised against a stub that says yes
// or no, where one that reached for the real gate would need a SCIM endpoint to answer before any
// assertion about definitions could be made.

import type { Application, Request, Response } from 'express';
import type {
  DefinitionPayload,
  DefinitionVersionPayload,
  PreflightPayload,
  ScopePreviewPayload,
  SelectableWorkspacePayload,
  SetupDraftPayload,
} from '../../shared/api/contract.js';
import {
  DefinitionError,
  archive,
  currentVersion,
  define,
  resolveScope,
  revise,
  unarchive,
  type AssessmentDefinition,
  type Attribution,
  type DefinitionVersion,
  type Draft,
  type Measurement,
  type PillarTarget,
  type Revision,
} from '../define/definition.js';
import { DefinitionConflict, type DefinitionStore } from '../define/store.js';
import {
  SetupError,
  ready,
  resumeAt,
  standingOf,
  troubles,
  type DraftScope,
  type DraftTarget,
  type SetupDraft,
} from '../define/setup.js';
import type { SetupDraftStore } from '../define/setup-store.js';
import { preflight, type CheckSources, type Preflight, type Probe, type SignalSources } from '../define/preflight.js';
import type { WorkspaceDirectory, WorkspaceRow } from '../collect/sql/shapes.js';
import type { EstateSummary, WorkspaceRef } from '../scan/estate.js';
import type { ScanStore } from '../scan/store.js';
import type { Act } from '../audit/record.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';

export interface DefinitionRouteOptions {
  /** Absent means definitions are not kept, and the routes say so rather than losing one. */
  readonly definitions?: DefinitionStore;
  /**
   * Where an assessment part-written is kept. Absent means a reload loses it.
   *
   * Separate from `definitions` rather than folded into it because the two have opposite lifecycles:
   * a definition is never deleted and a draft always is, and one interface offering both would let a
   * caller archive a draft or delete a version.
   */
  readonly drafts?: SetupDraftStore;
  /** What this install does about keeping them, in the reader's terms. */
  readonly definitionStorage?: string;
  /** Read for the workspace list, which comes from the last scan's directory. */
  readonly store: ScanStore;
  /**
   * Reads the current account directory when no scan has recorded one yet.
   *
   * This is one bounded system-table statement, not a scan. It is injected because the route module
   * does not own credentials, warehouse bindings or collectors, and because a fresh install otherwise
   * has to start the account-wide scan before it can offer the narrower scope the reader wanted.
   */
  readonly currentDirectory?: (request: Request) => Promise<{
    readonly directory?: WorkspaceDirectory;
    readonly asOf: Date;
    readonly unavailable?: string;
  }>;
  /**
   * Establishes that the caller may change something, or throws, and opens the act for the log.
   *
   * The act comes back with the identity rather than being a second injected function, because
   * whichever of the two a route forgot would be the one that mattered: an identity with no act is
   * an unrecorded mutation, and an act with no identity cannot be attributed. One call, both.
   *
   * It takes the response as well as the request, which reads oddly for a permission check and is
   * what makes the act impossible to leave open: the gate binds the act's close to the response's,
   * so a handler that returns early still records something. See `begin` in `routes.ts`.
   */
  readonly permitted: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly target?: AuditTarget }
  ) => Promise<{ readonly actor: string; readonly act: Act }>;
  /** Turns a thrown cause into the response it deserves. */
  readonly respondToFailure: (response: Response, cause: unknown) => void;
  /**
   * The pillar ids this build measures, for refusing a definition that names one it does not.
   *
   * Checked here rather than in `define` because whether a pillar exists is catalogue knowledge, and a
   * definition has to be constructible from a stored row without reading the catalogue — a build that
   * dropped a pillar would otherwise make every definition naming it unreadable rather than merely
   * unrunnable. `pillarsFrom` in `routes.ts` refuses an unknown id on a scan request for the same
   * reason, and the argument is stronger for a definition: a scan request is one run, while a definition
   * repeats its mistake on every run at a stable fingerprint, so the trend reads as healthy while
   * nothing is measured.
   *
   * Absent means the check is skipped, which is what a test that does not care about pillars wants.
   */
  readonly pillars?: readonly string[];
  /** Injected so a test can pin the version's timestamp. */
  readonly now?: () => Date;
  /** Injected for the same reason, and because a definition's id has to be stable to reference. */
  readonly newId?: () => string;
  /**
   * Builds a read against one table, as the caller.
   *
   * A factory taking the request rather than a bound probe, because the authority has to be the
   * caller's: a preflight run on the app's own identity would answer a question nobody asked and
   * answer it optimistically, since the service principal is the more privileged of the two on most
   * installs. Absent means no warehouse is bound and the route says so.
   */
  readonly probeFor?: (request: Request, actor: string) => Probe;
  /** What the assessment's checks read. Absent alongside `probeFor`, and for the same reason. */
  readonly sources?: (measurement: Measurement) => {
    readonly checks: readonly CheckSources[];
    readonly signals: readonly SignalSources[];
  };
}

const NO_STORE =
  'This installation is not keeping assessment definitions, so there is nowhere to put one. Bind a ' +
  'database and restart, and the definitions you create will survive a deploy.';

const NO_DRAFTS =
  'This installation is not keeping unfinished assessments, so leaving this page loses what you have ' +
  'written. Bind a database and restart, and you will be able to come back to it.';

/**
 * A lookback the preview passes to `resolveScope` and that `resolveScope` never reads.
 *
 * The signature takes a whole `Measurement` because the scope resolution belongs with the definition
 * and not with the preview, and widening it to take a scope alone would be a change to the domain to
 * suit one caller. One is used rather than thirty so that a reader who goes looking cannot mistake it
 * for a default the preview is applying.
 */
const MIN_LOOKBACK_FOR_PREVIEW = 1;

/**
 * Answers with a refusal this route decided on, and closes the act with the same word.
 *
 * These are the refusals a gate cannot make: the id is unknown, the version is stale. They are not
 * failures of the app and they are not the gate turning somebody away — they are an act that was
 * permitted and did not happen, which is what `failed` means in `AuditOutcome`.
 *
 * The body's `error` doubles as the audit reason, and that is the whole point of the helper. Two
 * vocabularies for one refusal drift apart, and the one that drifts unnoticed is the one in the log,
 * because nobody reads it until the day it matters. `settle` would catch a missed close and write
 * `http-404`; this is what makes the row say `unknown-definition` instead.
 */
async function refuse(
  response: Response,
  act: Act,
  status: number,
  error: string,
  message: string,
  extra: Readonly<Record<string, unknown>> = {}
): Promise<void> {
  await act.failed(error);
  response.status(status).json({ error, message, ...extra });
}

export function registerDefinitionRoutes(app: Application, options: DefinitionRouteOptions): void {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  /**
   * Every definition, with its full version history.
   *
   * Archived ones included. The picker filters them out of what a new run may start from, but the
   * list is also how somebody finds last quarter's assessment to see what it covered, and an
   * archived definition is exactly the one they are looking for.
   */
  app.get('/api/definitions', async (_request, response) => {
    const store = options.definitions;
    if (store == null) {
      // 200 rather than 503, with the durability said plainly. An install with no database can still
      // be looked at, and a page that failed to load would tell the reader less than an empty list
      // that explains itself.
      response.json({ definitions: [], durable: false, storage: NO_STORE });
      return;
    }

    try {
      const definitions = await store.all();
      response.json({
        definitions: definitions.map(present),
        durable: store.durable,
        ...(options.definitionStorage != null ? { storage: options.definitionStorage } : {}),
      });
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  app.post('/api/definitions', async (request, response) => {
    const store = options.definitions;
    if (store == null) {
      response.status(503).json({ error: 'definitions-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      // Before the body is read, like every other mutation: a definition nobody is permitted to
      // create should not be validated or partially stored first.
      const permission = await options.permitted(request, response, 'definition.create');
      const { actor } = permission;
      act = permission.act;

      const draft = draftFrom(request.body);
      measurable(draft.measurement, options);
      targetable(draft.targets, options);
      const definition = define(draft, newId(), now(), actor);
      await store.create(definition);
      // Recorded before the draft is forgotten, so an event exists for the assessment even if the
      // tidying that follows it fails. The other order would report the create as failed when the
      // thing the reader cares about — the assessment — is stored.
      await act.performed({ kind: 'definition', id: definition.id });
      // The assessment exists, so the draft of it has nothing left to say. Discarded here rather
      // than by a second call from the browser, because a failure between the two would leave the
      // wizard offering to resume an assessment that had already been created — and the author would
      // then either create it twice or delete the real one to stop being asked.
      await forget(options, actor, undefined);
      response.status(201).json(present(definition));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * A revision, as a new version rather than an edit.
   *
   * The version number the author last saw is required in the body, and that is the concurrency
   * control. Two people revising from the same read both send 1, the first append lands as 2, and
   * the second is told it is working from a stale copy — rather than the last write silently
   * standing and the other author's change disappearing from an audit record.
   */
  app.post('/api/definitions/:id/versions', async (request, response) => {
    const store = options.definitions;
    if (store == null) {
      response.status(503).json({ error: 'definitions-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      const id = request.params.id ?? '';
      const permission = await options.permitted(request, response, 'definition.revise', {
        target: { kind: 'definition', id },
      });
      const { actor } = permission;
      act = permission.act;
      const existing = await store.get(id);
      if (existing == null) {
        await refuse(response, permission.act, 404, 'unknown-definition', `No assessment with id ${id}.`);
        return;
      }

      const body = asObject(request.body);
      const from = body.fromVersion;
      if (typeof from !== 'number' || !Number.isInteger(from)) {
        throw new DefinitionError(
          'A revision has to say which version it was made from, so a change made against a copy ' +
            'somebody else has already replaced can be refused rather than applied.'
        );
      }
      const current = currentVersion(existing);
      if (from !== current.version) {
        await refuse(
          response,
          permission.act,
          409,
          'stale-definition',
          `This was revised from version ${String(from)}, and version ${String(current.version)} is ` +
            `now current — ${current.createdBy} changed it. Re-read it and decide against what they changed.`,
          { currentVersion: current.version }
        );
        return;
      }

      const revision = revisionFrom(body);
      if (revision.measurement != null) measurable(revision.measurement, options);
      targetable(revision.targets, options);
      const revised = revise(existing, revision, now(), actor);
      const added = revised.versions.at(-1);
      if (added == null) throw new DefinitionError('The revision produced no version.');
      await store.appendVersion(id, added);
      await act.performed({ kind: 'definition', id });
      await forget(options, actor, id);
      response.status(201).json(present(revised));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  app.post('/api/definitions/:id/archive', async (request, response) => {
    const store = options.definitions;
    if (store == null) {
      response.status(503).json({ error: 'definitions-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      const id = request.params.id ?? '';
      const target = { kind: 'definition', id } as const;
      act = (await options.permitted(request, response, 'definition.archive', { target })).act;

      const existing = await store.get(id);
      if (existing == null) {
        await refuse(response, act, 404, 'unknown-definition', `No assessment with id ${id}.`);
        return;
      }

      const at = now();
      await store.archive(id, at);
      await act.performed(target);
      response.json(present(archive(existing, at)));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Put an archived definition back.
   *
   * Its own route and its own audited action rather than a flag on the archive route, because the two
   * are different acts and the log is read to answer "who closed this". `POST /archive` with
   * `{ archived: false }` records one action for both and leaves that question needing the body of
   * every event to answer it.
   *
   * Reopening something already open succeeds rather than 409s. The button only appears on an archived
   * row, so the way to arrive here is a double submit or a stale page, and in both the caller wants
   * the definition open and it is. Refusing would report a failure for a state the caller asked for.
   */
  app.post('/api/definitions/:id/unarchive', async (request, response) => {
    const store = options.definitions;
    if (store == null) {
      response.status(503).json({ error: 'definitions-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      const id = request.params.id ?? '';
      const target = { kind: 'definition', id } as const;
      act = (await options.permitted(request, response, 'definition.unarchive', { target })).act;

      const existing = await store.get(id);
      if (existing == null) {
        await refuse(response, act, 404, 'unknown-definition', `No assessment with id ${id}.`);
        return;
      }

      await store.unarchive(id);
      await act.performed(target);
      response.json(present(unarchive(existing)));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Whether this assessment can run as the caller, before anyone runs it.
   *
   * A mutation gate on a route that changes nothing, deliberately. It executes statements against the
   * customer's warehouse as the caller, which is the same authority a scan needs and not something a
   * reader of the app should be able to spend on their behalf.
   */
  app.post('/api/definitions/:id/preflight', async (request, response) => {
    const store = options.definitions;
    if (store == null) {
      response.status(503).json({ error: 'definitions-unavailable', message: NO_STORE });
      return;
    }
    if (options.probeFor == null || options.sources == null) {
      response.status(503).json({
        error: 'preflight-unavailable',
        message:
          'This installation has no SQL warehouse bound, so there is nothing to check the grants ' +
          'against. Bind one and the preflight will run.',
      });
      return;
    }

    let act: Act | undefined;
    try {
      const id = request.params.id ?? '';
      const target = { kind: 'definition', id } as const;
      const permission = await options.permitted(request, response, 'definition.preflight', { target });
      const { actor } = permission;
      act = permission.act;

      const definition = await store.get(id);
      if (definition == null) {
        await refuse(response, act, 404, 'unknown-definition', `No assessment with id ${id}.`);
        return;
      }

      const measurement = currentVersion(definition).measurement;
      const { checks, signals } = options.sources(measurement);
      const latest = await options.store.latest();
      const directory = latest == null ? undefined : directoryFrom(latest.estate);
      // A scan that ran and could not read the directory is a different situation from no scan
      // having run, and the collector already wrote the sentence that names the missing grant.
      // Without this the verdict tells an author to run a scan they have already run.
      const unreadable = directory == null ? latest?.estate.undeterminedReason : undefined;

      const result = await preflight(
        {
          definition,
          identity: actor,
          checks,
          signals,
          ...(directory != null ? { directory } : {}),
          ...(unreadable != null ? { directoryUnreadable: unreadable } : {}),
        },
        options.probeFor(request, actor),
        now()
      );
      // Recorded because it ran, not because it passed. A preflight that reports missing grants is a
      // preflight that happened; the verdict is on the response, and a log that only held the
      // successful ones would answer "who checked" with a filtered list.
      await act.performed(target);

      response.json({
        ...presentPreflight(result),
        // The scope half of this is as fresh as the last scan and the grant half is live, which is a
        // difference a reader acting on it has to be told rather than left to infer from a date.
        ...(latest != null ? { scopeAsOf: latest.startedAt.toISOString() } : {}),
      });
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Everything the caller has part-written, with what is left to do on each.
   *
   * Gated, and gated on a read, which is the one place in this file that needs saying. The gate is
   * not protecting the app from a write here — it is establishing *whose* drafts these are from an
   * identity the app verified rather than from a header the caller set. A draft holds a scope
   * somebody is part-way through proposing and has not shown anyone, and handing one to whoever
   * asserts the right email would be a disclosure this app has no reason to risk to save a round
   * trip on a page nobody loads in a loop.
   *
   * The list rather than one draft, because the page needs it: an author with an unfinished revision
   * of last quarter's assessment should be told so where the assessments are, not only after
   * navigating into the one they happened to remember.
   */
  app.get('/api/definitions/drafts', async (request, response) => {
    const store = options.drafts;
    if (store == null) {
      // 200 with the durability said plainly, like the definitions list. An install with no database
      // can still write an assessment; what it cannot do is let somebody come back to one tomorrow.
      response.json({ drafts: [], durable: false, storage: NO_DRAFTS });
      return;
    }

    let act: Act | undefined;
    try {
      const permission = await options.permitted(request, response, 'draft.read');
      const { actor } = permission;
      act = permission.act;

      const drafts = await store.mine(actor);
      await act.performed();
      response.json({
        drafts: await Promise.all(drafts.map((draft) => presentDraft(draft, options))),
        durable: store.durable,
        ...(options.definitionStorage != null ? { storage: options.definitionStorage } : {}),
      });
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Keeps what has been written so far.
   *
   * A `PUT` rather than a `POST` because it is idempotent by design: the key is the author and the
   * target, so saving twice leaves one draft rather than two. The author is taken from the gate and
   * never from the body — a draft that could name its own owner would be a draft one caller could
   * write into another's list.
   *
   * Nothing here is validated into a definition. That is the point of a draft: a lookback of nothing
   * and a name of nothing are legitimate states to be in half way through, and the response says
   * what is still missing rather than refusing to remember it.
   */
  app.put('/api/definitions/drafts', async (request, response) => {
    const store = options.drafts;
    if (store == null) {
      response.status(503).json({ error: 'drafts-unavailable', message: NO_DRAFTS });
      return;
    }

    let act: Act | undefined;
    try {
      const permission = await options.permitted(request, response, 'draft.save');
      const { actor } = permission;
      act = permission.act;

      const draft = draftContentFrom(request.body, actor, now());
      await store.save(draft);
      // The target is the assessment being revised where there is one, and absent for a new
      // assessment — which has no id until it is created. A draft's own key is the author, and
      // naming the author as the target would put the actor in the row twice.
      await act.performed(draft.definitionId != null ? { kind: 'definition', id: draft.definitionId } : undefined);
      response.json(await presentDraft(draft, options));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Throws away what has been written.
   *
   * Deleted rather than marked abandoned, unlike everything else this app stores. Nothing references
   * a draft, so nothing dangles — and a draft kept after its author decided against it means the
   * wizard offers to resume work they walked away from, every time they visit.
   */
  app.delete('/api/definitions/drafts', async (request, response) => {
    const store = options.drafts;
    if (store == null) {
      response.status(503).json({ error: 'drafts-unavailable', message: NO_DRAFTS });
      return;
    }

    let act: Act | undefined;
    try {
      const permission = await options.permitted(request, response, 'draft.discard');
      const { actor } = permission;
      act = permission.act;

      const of = targetFrom(request.query.for);
      await store.discard(actor, of);
      await act.performed(of != null ? { kind: 'definition', id: of } : undefined);
      response.status(204).end();
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * What a scope would cover, before it is saved.
   *
   * A `POST` for a read, which wants a reason. The alternative was a `GET` with the workspace ids in
   * the query string, and an account with five hundred workspaces selected puts eight kilobytes
   * there — past what some proxies in front of this app will forward, and the failure would be a
   * preview that worked for small estates and broke for exactly the large ones that need it.
   *
   * Resolved against the last scan's directory rather than a live read, and `asOf` says when that
   * was. A live read means a second path into the collector, and the place a live check belongs is
   * the preflight — which is a separate action because it spends the customer's warehouse.
   */
  app.post('/api/definitions/scope', async (request, response) => {
    let act: Act | undefined;
    try {
      // Gated even though nothing is written, because the alternative is an unauthenticated endpoint
      // that enumerates a customer's workspaces by name. `/api/workspaces` is a read of the same
      // data and is not gated, which is a question worth revisiting — but not one to answer by
      // adding a second way in.
      act = (await options.permitted(request, response, 'scope.preview')).act;
      const scope = scopeFrom(asObject(request.body).scope);
      const latest = await options.store.latest();
      const directory = latest == null ? undefined : directoryFrom(latest.estate);

      if (directory == null) {
        response.json({
          assessed: [],
          omitted: [],
          outOfScope: 0,
          complete: false,
          description:
            'What this scope covers is not known yet, because nothing has read the account directory to hold it ' +
            'against.',
          ...(latest != null ? { asOf: latest.startedAt.toISOString() } : {}),
          unavailable:
            latest == null
              ? 'No scan has run yet, so there is no account directory to resolve this scope against. Run one, and ' +
                'this will say what the scope covers.'
              : (latest.estate.undeterminedReason ??
                'The last scan could not read the account directory, so there is nothing to resolve this scope ' +
                  'against.'),
        });
        return;
      }

      // The lookback is not asked for and not used. It decides what a run measures and has no
      // bearing on which workspaces are in it, and taking it here would imply otherwise.
      const resolution = resolveScope({ scope, lookbackDays: MIN_LOOKBACK_FOR_PREVIEW }, directory);
      const named: ScopePreviewPayload = {
        assessed: resolution.assessed.map((workspace) => ({
          workspaceId: workspace.workspaceId,
          name: workspace.name,
        })),
        omitted: resolution.omitted.map((workspace) => ({
          workspaceId: workspace.workspaceId,
          ...(workspace.name != null ? { name: workspace.name } : {}),
          reason: workspace.reason,
        })),
        outOfScope: resolution.outOfScope.length,
        complete: resolution.complete,
        description: resolution.description,
        ...(latest != null ? { asOf: latest.startedAt.toISOString() } : {}),
      };
      await act.performed();
      response.json(named);
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * The workspaces a definition can name, and whether an assessment could cover each.
   *
   * The last scan's directory is reused when there is one, with the date it was read. A fresh install
   * has no such record, so it issues the collector's one bounded directory statement on demand. It
   * does not start a scan: the reader must be able to choose a narrow scope before any scan begins.
   */
  app.get('/api/workspaces', async (request, response) => {
    try {
      const latest = await options.store.latest();
      if (latest == null) {
        const current = await options.currentDirectory?.(request);
        if (current?.directory == null) {
          response.json({
            workspaces: [],
            ...(current != null ? { asOf: current.asOf.toISOString() } : {}),
            unavailable:
              current?.unavailable ??
              'No scan has run yet, and this installation cannot read the account directory on demand.',
          });
          return;
        }

        response.json({
          workspaces: selectableDirectory(current.directory),
          asOf: current.asOf.toISOString(),
        });
        return;
      }

      const { estate } = latest;
      if (estate.undeterminedReason != null) {
        response.json({
          workspaces: [],
          asOf: latest.startedAt.toISOString(),
          // The collector's own sentence, which names the missing grant rather than leaving the
          // reader to guess why the estate is unknown.
          unavailable: estate.undeterminedReason,
        });
        return;
      }

      // Out of scope counts as assessable, because it is: the last run was not asked about it, and the
      // author reading this list is deciding what the next one asks about. Omitting them would make a
      // narrowed assessment permanently unwidenable from the picker that defines it.
      const workspaces: SelectableWorkspacePayload[] = [
        ...estate.assessed.map((workspace) => selectable(workspace, true)),
        ...(estate.outOfScope ?? []).map((workspace) => selectable(workspace, true)),
        ...estate.excluded.map((workspace) => selectable(workspace, false)),
      ].sort((a, b) => a.name.localeCompare(b.name));

      response.json({ workspaces, asOf: latest.startedAt.toISOString() });
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });
}

/**
 * The last scan's estate as a directory the domain can resolve a scope against.
 *
 * A translation rather than a second source: `resolveScope` takes the shape the collector produces,
 * and the estate summary is that shape after the scan flattened it for storage.
 *
 * The home region has to come across. `resolveScope` reads its absence as "this deployment could not
 * establish which region it reads" and says so — a caveat about an assessment possibly spanning regions
 * that bill separately. Dropping the field here would print that caveat on every preflight and every
 * scope preview in an account whose region the scan had established, which is a warning a reader cannot
 * act on and would learn to ignore.
 *
 * `regionUnverified` cannot come across, and comes back empty rather than invented. The summary keeps a
 * count and this field is a set of workspaces, so there is no way to say which ones without naming
 * workspaces nobody measured — and the count is already in front of the reader, in the estate note on
 * the run this directory came from.
 */
function directoryFrom(estate: EstateSummary): WorkspaceDirectory | undefined {
  if (estate.undeterminedReason != null) return undefined;

  // Assessed *and* out of scope, because `live` here means assessable and being outside one assessment's
  // scope is not a property of the workspace. A definition naming a workspace the last run was not asked
  // about would otherwise resolve it as `unknown` — "not in the account directory at all" — of a
  // workspace the run had listed as running and deliberately skipped.
  const live = [...estate.assessed, ...(estate.outOfScope ?? [])].map((workspace) => row(workspace, true));
  const excluded = estate.excluded.map((workspace) => ({
    ...row(workspace, false),
    reason: workspace.reason ?? ('not-running' as const),
  }));

  return {
    workspaces: [...live, ...excluded],
    live,
    excluded,
    regionUnverified: [],
    // Empty because being outside the last run's scope says nothing about the definition being resolved
    // now. Those workspaces are in `live` above, and `resolveScope` decides what this scope leaves out.
    outOfScope: [],
    ...(estate.region != null ? { homeRegion: estate.region } : {}),
  };
}

function row(workspace: WorkspaceRef, live: boolean): WorkspaceRow {
  return {
    workspaceId: workspace.id,
    name: workspace.name,
    ...(workspace.url != null ? { url: workspace.url } : {}),
    status: workspace.status,
    live,
  };
}

function presentPreflight(result: Preflight): PreflightPayload {
  return {
    ranAt: result.ranAt.toISOString(),
    ranAs: result.ranAs,
    definitionId: result.definitionId,
    version: result.version,
    fingerprint: result.fingerprint,
    ready: result.ready,
    verdict: result.verdict,
    sources: result.sources.map((source) => ({
      table: source.table,
      schema: source.schema,
      reading: source.reading,
      detail: source.detail,
      ...(source.grant != null ? { grant: source.grant } : {}),
      blocks: source.blocks,
    })),
    blocked: result.blocked.map((check) => ({
      controlId: check.controlId,
      pillarId: check.pillarId,
      needs: check.needs,
    })),
    // Sent only when there was a directory to resolve against. An undetermined resolution has real
    // content — a reason and a description — but every field of this payload is a set of workspaces, and
    // sending three empty ones plus a caveat invites the browser to draw an estate of nothing. The
    // reason reaches the reader through the verdict, which is a sentence rather than a list.
    ...(result.scope.undeterminedReason == null
      ? {
          scope: {
            assessed: result.scope.assessed.map((workspace) => workspace.workspaceId),
            omitted: result.scope.omitted.map((workspace) => ({
              workspaceId: workspace.workspaceId,
              ...(workspace.name != null ? { name: workspace.name } : {}),
              reason: workspace.reason,
            })),
            outOfScope: result.scope.outOfScope.length,
            complete: result.scope.complete,
            description: result.scope.description,
          },
        }
      : {}),
  };
}

function selectable(
  workspace: { id: string; name: string; url?: string; status: string; reason?: 'not-running' | 'other-region' },
  assessable: boolean
): SelectableWorkspacePayload {
  return {
    id: workspace.id,
    name: workspace.name,
    ...(workspace.url != null ? { url: workspace.url } : {}),
    status: workspace.status,
    assessable,
    ...(workspace.reason != null ? { reason: workspace.reason } : {}),
  };
}

/** The collector's live directory in the same payload shape as a stored scan's flattened estate. */
function selectableDirectory(directory: WorkspaceDirectory): SelectableWorkspacePayload[] {
  const live = new Set(directory.live.map((workspace) => workspace.workspaceId));
  const excluded = new Map(directory.excluded.map((workspace) => [workspace.workspaceId, workspace.reason]));

  return directory.workspaces
    .map((workspace) =>
      selectable(
        {
          id: workspace.workspaceId,
          name: workspace.name,
          ...(workspace.url != null ? { url: workspace.url } : {}),
          status: workspace.status,
          ...(excluded.get(workspace.workspaceId) != null ? { reason: excluded.get(workspace.workspaceId) } : {}),
        },
        live.has(workspace.workspaceId)
      )
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

function respond(response: Response, cause: unknown, options: DefinitionRouteOptions): void {
  if (cause instanceof DefinitionConflict) {
    response.status(409).json({ error: 'stale-definition', message: cause.message });
    return;
  }
  if (cause instanceof SetupError || cause instanceof DefinitionError) {
    response.status(400).json({ error: 'invalid-definition', message: cause.message });
    return;
  }
  options.respondToFailure(response, cause);
}

/**
 * Forgets this author's draft for a target, and does not fail the request if it cannot.
 *
 * Called after a definition has been created or revised, which is the operation the caller asked for
 * and which has already succeeded. Failing the response now would tell an author their assessment was
 * not saved when it was, and they would write it again — so the draft is left behind instead, which
 * costs them one dismissal.
 */
async function forget(options: DefinitionRouteOptions, author: string, definitionId?: string): Promise<void> {
  try {
    await options.drafts?.discard(author, definitionId);
  } catch {
    // Deliberately swallowed. See above.
  }
}

/**
 * The draft, plus what the wizard needs to know about it that is not stored.
 *
 * The standing needs the assessment being revised, which is a read of the definition store, so this
 * is async and a draft of a new assessment skips the read. A store that is absent or that throws
 * leaves the standing as `gone`, which is the honest answer: the app cannot see the assessment this
 * revises, and whether that is because it was removed or because the database is unreachable is not
 * something it can tell from here.
 */
async function presentDraft(draft: SetupDraft, options: DefinitionRouteOptions): Promise<SetupDraftPayload> {
  const definition = draft.definitionId == null ? undefined : await read(options, draft.definitionId);
  const { standing, warning } = standingOf(draft, definition);
  const name = definition == null ? undefined : currentVersion(definition).attribution.name;

  return {
    ...(draft.definitionId != null ? { definitionId: draft.definitionId } : {}),
    ...(draft.fromVersion != null ? { fromVersion: draft.fromVersion } : {}),
    ...(draft.name != null ? { name: draft.name } : {}),
    ...(draft.purpose != null ? { purpose: draft.purpose } : {}),
    ...(draft.owners != null ? { owners: draft.owners } : {}),
    ...(draft.scope != null ? { scope: draft.scope } : {}),
    ...(draft.lookbackDays != null ? { lookbackDays: draft.lookbackDays } : {}),
    ...(draft.pillars != null ? { pillars: draft.pillars } : {}),
    ...(draft.targets != null ? { targets: draft.targets } : {}),
    ...(draft.note != null ? { note: draft.note } : {}),
    savedAt: draft.savedAt.toISOString(),
    ...(name != null ? { definitionName: name } : {}),
    ready: ready(draft),
    troubles: troubles(draft).map((one) => ({ step: one.step, trouble: one.trouble })),
    resumeAt: resumeAt(draft),
    standing,
    ...(warning != null ? { warning } : {}),
  };
}

/**
 * Refuses a measurement naming a pillar this build does not measure.
 *
 * Refused rather than narrowed. A definition that names one real pillar and one imaginary one is not a
 * definition of the real one — the author meant both, and quietly measuring half of what they asked for
 * produces a score that is not of what its own definition says it is of. The message names what was not
 * recognised and what is, because the usual cause is a rename between builds and the fix is a word.
 */
function measurable(measurement: Measurement, options: DefinitionRouteOptions): void {
  const measured = options.pillars;
  if (measured == null || measurement.pillars == null) return;

  const unknown = measurement.pillars.map((id) => id.trim()).filter((id) => id !== '' && !measured.includes(id));
  if (unknown.length === 0) return;

  throw new DefinitionError(
    `This build does not measure ${unknown.join(', ')}. It measures ${measured.join(', ')}. An assessment ` +
      'that named a pillar nothing measures would report a score of the pillars it could measure, under a ' +
      'name that claimed more.'
  );
}

/**
 * Refuses a target for a pillar this build does not measure.
 *
 * Separate from `measurable` above because the two guard different fields against the same catalogue,
 * and folding them together would report a target's typo as a fault in the measurement — sending the
 * author to the pillar list, which is correct, and to the wrong step of it.
 *
 * A target for a real pillar the *assessment* leaves out is the domain's to refuse, not this one's:
 * that rule has to hold for a stored version too. This one only knows what this build can measure at
 * all, which is the part the catalogue is the authority for.
 */
function targetable(targets: readonly PillarTarget[] | undefined, options: DefinitionRouteOptions): void {
  const measured = options.pillars;
  if (measured == null || targets == null) return;

  const unknown = targets.map((target) => target.pillar).filter((pillar) => !measured.includes(pillar));
  if (unknown.length === 0) return;

  throw new DefinitionError(
    `This build does not measure ${unknown.join(', ')}, so a target for ${unknown.length === 1 ? 'it' : 'them'} ` +
      `could never be reported against. It measures ${measured.join(', ')}.`
  );
}

async function read(options: DefinitionRouteOptions, id: string): Promise<AssessmentDefinition | undefined> {
  try {
    return await options.definitions?.get(id);
  } catch {
    return undefined;
  }
}

/**
 * A request body into a draft, keeping whatever is there and refusing whatever is malformed.
 *
 * The distinction from `draftFrom` is the whole reason both exist. That one refuses a body missing a
 * lookback, because a definition without one cannot be fingerprinted. This one keeps a body missing
 * everything, because that is what a draft is — but it still refuses a lookback of `"thirty"`, since
 * storing it would put a value in front of `troubles` that the author never typed and get back a
 * complaint about a number they did not choose.
 */
function draftContentFrom(body: unknown, author: string, savedAt: Date): SetupDraft {
  const raw = asObject(body);
  const { definitionId, fromVersion, name, purpose, owners, lookbackDays, pillars, note } = raw;

  if (definitionId != null && typeof definitionId !== 'string') {
    throw new SetupError('A revision names the assessment it revises by id.');
  }
  // A blank id is refused rather than read as "no id", because the two are stored in the same place.
  // `targetOf` keys a draft on `definitionId ?? ''`, so an empty string is the key of the new-
  // assessment draft — and a PUT carrying `definitionId: ""` would land on top of whatever new
  // assessment the author had part-written, replacing it with a revision of nothing and reporting
  // success. Refusing is also the more useful answer: a caller sending a blank id has a bug, and
  // silently treating it as a new assessment hides it.
  if (typeof definitionId === 'string' && definitionId.trim() === '') {
    throw new SetupError(
      'A revision names the assessment it revises by id. Leave the id out altogether for a new ' +
        'assessment rather than sending an empty one.'
    );
  }
  if (definitionId != null && fromVersion == null) {
    // Not a formality. `standingOf` cannot compare a draft to the assessment it came from without
    // it, and treats its absence as stale — so accepting one here would produce a draft that warned
    // about being superseded every time it was read, with nothing the author could do about it.
    throw new SetupError(
      'A revision has to say which version it was started from, so it can be told later that somebody ' +
        'else has changed the assessment since.'
    );
  }
  if (fromVersion != null && (typeof fromVersion !== 'number' || !Number.isInteger(fromVersion))) {
    throw new SetupError('A version is a whole number.');
  }
  if (name != null && typeof name !== 'string') throw new SetupError('A name is text.');
  if (purpose != null && typeof purpose !== 'string') throw new SetupError('A purpose is a sentence.');
  if (owners != null && !isStrings(owners)) throw new SetupError('Owners are named by their identities.');
  if (lookbackDays != null && typeof lookbackDays !== 'number') {
    throw new SetupError('A lookback is a number of days.');
  }
  if (pillars != null && !isStrings(pillars)) throw new SetupError('Pillars are named by their ids.');
  if (note != null && typeof note !== 'string') throw new SetupError('A note is a sentence.');

  const scope = draftScopeFrom(raw.scope);
  const targets = draftTargetsFrom(raw.targets);

  return {
    author,
    ...(definitionId != null ? { definitionId } : {}),
    ...(fromVersion != null ? { fromVersion } : {}),
    ...(name != null ? { name } : {}),
    ...(purpose != null ? { purpose } : {}),
    ...(owners != null ? { owners } : {}),
    ...(scope != null ? { scope } : {}),
    ...(lookbackDays != null ? { lookbackDays } : {}),
    ...(pillars != null ? { pillars } : {}),
    ...(targets != null ? { targets } : {}),
    ...(note != null ? { note } : {}),
    savedAt,
  };
}

/**
 * Targets as a draft holds them, which is looser than a definition's.
 *
 * A row with a score and no date is kept rather than dropped, for the reason an empty `selected` scope
 * is kept: an author who typed 80 and went to ask when the programme board wants it should find the 80
 * when they come back. Dropping the half-written row instead would make the wizard look like it had
 * silently disagreed with them.
 *
 * What is still refused is a value of the wrong type, on the same grounds as `lookbackDays`: an
 * `atLeast` of `"eighty"` stored here comes back to the author as a complaint about a number they
 * never typed.
 */
function draftTargetsFrom(raw: unknown): readonly DraftTarget[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new SetupError('Targets are a list, one per pillar.');

  return raw.map((entry: unknown) => {
    const target = asObject(entry);
    if (typeof target.pillar !== 'string') throw new SetupError('A target names the pillar it is for.');
    if (target.atLeast != null && typeof target.atLeast !== 'number') {
      throw new SetupError('A target is a score out of a hundred.');
    }
    if (target.by != null && typeof target.by !== 'string') throw new SetupError('A target date is a day.');
    return {
      pillar: target.pillar,
      ...(target.atLeast != null ? { atLeast: target.atLeast } : {}),
      ...(target.by != null ? { by: target.by } : {}),
    };
  });
}

/**
 * Scope as a draft holds it, which is looser than a definition's.
 *
 * `selected` with no workspaces yet is kept rather than rejected or turned into account reach.
 * Rejecting it would mean an author who ticked "these workspaces" and went to ask a colleague which
 * ones could not save; turning it into account reach would silently widen the scope they had just
 * started to narrow.
 */
function draftScopeFrom(raw: unknown): DraftScope | undefined {
  if (raw == null) return undefined;
  const scope = asObject(raw);
  if (scope.kind !== 'account' && scope.kind !== 'selected') {
    throw new SetupError('A scope is either the whole account or a set of workspaces that was chosen.');
  }
  const workspaceIds = scope.workspaceIds;
  if (workspaceIds != null && !isStrings(workspaceIds)) {
    throw new SetupError('A selected scope names its workspaces by id.');
  }
  return { kind: scope.kind, ...(workspaceIds != null ? { workspaceIds } : {}) };
}

/**
 * The target from a query string, where absent means the new assessment.
 *
 * Express hands back a string, an array of strings when the parameter is repeated, or a parsed object
 * when it looks like one. Anything but a single string is refused rather than coerced: `?for[]=a&for[]=b`
 * coerced to `a` would discard whichever draft the second one named.
 */
function targetFrom(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'string') throw new SetupError('An unfinished assessment is named by one id.');
  return raw === '' ? undefined : raw;
}

function present(definition: AssessmentDefinition): DefinitionPayload {
  return {
    id: definition.id,
    versions: definition.versions.map(presentVersion),
    ...(definition.archivedAt != null ? { archivedAt: definition.archivedAt.toISOString() } : {}),
  };
}

function presentVersion(version: DefinitionVersion): DefinitionVersionPayload {
  const { scope } = version.measurement;
  return {
    version: version.version,
    fingerprint: version.fingerprint,
    createdAt: version.createdAt.toISOString(),
    createdBy: version.createdBy,
    measurement: {
      scope: {
        kind: scope.kind,
        ...(scope.kind === 'selected' ? { workspaceIds: scope.workspaceIds } : {}),
      },
      lookbackDays: version.measurement.lookbackDays,
      ...(version.measurement.pillars != null ? { pillars: version.measurement.pillars } : {}),
    },
    attribution: version.attribution,
    ...(version.targets != null
      ? {
          targets: version.targets.map((target) => ({
            pillar: target.pillar,
            atLeast: target.atLeast,
            by: target.by.toISOString(),
          })),
        }
      : {}),
    ...(version.note != null ? { note: version.note } : {}),
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new DefinitionError('An assessment is described by an object.');
  }
  return body as Record<string, unknown>;
}

/**
 * A request body into a draft, refusing rather than defaulting.
 *
 * Nothing here is filled in on the caller's behalf beyond the pillar list's absence, which the
 * domain already treats as a meaningful value. A missing lookback defaulted to ninety days would put
 * a number nobody chose into the fingerprint every run is compared on.
 */
function draftFrom(body: unknown): Draft {
  const raw = asObject(body);
  return {
    measurement: measurementFrom(raw.measurement),
    attribution: attributionFrom(raw.attribution),
    ...(raw.targets != null ? { targets: targetsFrom(raw.targets) } : {}),
  };
}

function revisionFrom(body: Record<string, unknown>): Revision {
  const note = body.note;
  if (body.measurement == null && body.attribution == null && body.targets == null) {
    throw new DefinitionError('A revision has to change the measurement, the attribution or the targets.');
  }
  return {
    ...(body.measurement != null ? { measurement: measurementFrom(body.measurement) } : {}),
    ...(body.attribution != null ? { attribution: attributionFrom(body.attribution) } : {}),
    // Present-and-empty is how a target is withdrawn, so this reads the key rather than the length.
    // `body.targets != null` above and here have to agree, or withdrawing every target would be
    // refused as a revision that changes nothing.
    ...(body.targets != null ? { targets: targetsFrom(body.targets) } : {}),
    ...(typeof note === 'string' ? { note } : {}),
  };
}

/**
 * Targets off a request body, refusing anything that is not one.
 *
 * The date is the reason this is more than a cast. It arrives as a string and the domain holds a
 * `Date`, and an unparseable one has to be refused here rather than turned into an `Invalid Date` for
 * `normaliseTargets` to reject with a less useful message — this one can name the pillar.
 *
 * What is deliberately *not* checked here is whether the pillar exists or is in the assessment. The
 * first belongs with the catalogue and is done where the other pillar-existence checks are done; the
 * second is a cross-field rule the domain owns, because it has to hold for a stored version as well
 * as for a request.
 */
function targetsFrom(raw: unknown): readonly PillarTarget[] {
  if (!Array.isArray(raw)) throw new DefinitionError('Targets are a list, one per pillar.');

  return raw.map((entry: unknown) => {
    const target = asObject(entry);
    const pillar = target.pillar;
    if (typeof pillar !== 'string' || pillar.trim() === '') {
      throw new DefinitionError('A target names the pillar it is a target for.');
    }
    if (typeof target.atLeast !== 'number') {
      throw new DefinitionError(`The target for ${pillar} has to say what score it commits to.`);
    }
    if (typeof target.by !== 'string' && !(target.by instanceof Date)) {
      throw new DefinitionError(`The target for ${pillar} has to say by when.`);
    }
    const by = target.by instanceof Date ? target.by : new Date(target.by);
    if (Number.isNaN(by.getTime())) {
      throw new DefinitionError(`The date on the ${pillar} target could not be read as a date.`);
    }
    return { pillar: pillar.trim(), atLeast: target.atLeast, by };
  });
}

function measurementFrom(raw: unknown): Measurement {
  const measurement = asObject(raw);
  const lookbackDays = measurement.lookbackDays;
  if (typeof lookbackDays !== 'number') {
    throw new DefinitionError('An assessment has to say how far back it looks.');
  }

  const pillars = measurement.pillars;
  if (pillars != null && !isStrings(pillars)) throw new DefinitionError('Pillars are named by their ids.');

  return {
    scope: scopeFrom(measurement.scope),
    lookbackDays,
    ...(pillars != null ? { pillars } : {}),
  };
}

function scopeFrom(raw: unknown): Measurement['scope'] {
  const scope = asObject(raw);
  if (scope.kind === 'account') return { kind: 'account' };
  if (scope.kind === 'selected') {
    const workspaceIds = scope.workspaceIds;
    if (!isStrings(workspaceIds)) throw new DefinitionError('A selected scope names its workspaces by id.');
    // Trimmed and refused here rather than left to `normalise`, because this parser feeds the scope
    // preview as well as the save, and the preview does not go through `normalise` at all. An empty
    // selection resolved cleanly there — nothing omitted, so `complete: true` — and reported that a
    // scope covering no workspaces covers everything it claims to. Which is true, and useless: the
    // same scope is refused the moment somebody tries to save it.
    const named = workspaceIds.map((id) => id.trim()).filter((id) => id !== '');
    if (named.length === 0) {
      throw new DefinitionError(
        'A selected scope names at least one workspace. An assessment that covers nothing measures ' +
          'nothing; to cover everything, scope it to the account instead.'
      );
    }
    return { kind: 'selected', workspaceIds: named };
  }
  throw new DefinitionError('A scope is either the whole account or a set of workspaces that was chosen.');
}

function attributionFrom(raw: unknown): Attribution {
  const attribution = asObject(raw);
  const { name, purpose, owners } = attribution;
  if (typeof name !== 'string') throw new DefinitionError('An assessment needs a name somebody can ask for it by.');
  if (purpose != null && typeof purpose !== 'string') throw new DefinitionError('A purpose is a sentence.');
  if (owners != null && !isStrings(owners)) throw new DefinitionError('Owners are named by their identities.');

  return {
    name,
    ...(typeof purpose === 'string' ? { purpose } : {}),
    owners: owners ?? [],
  };
}

function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((one) => typeof one === 'string');
}
