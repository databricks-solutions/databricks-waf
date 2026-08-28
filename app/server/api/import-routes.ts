// The HTTP surface for importing admin-collected evidence.
//
// Its own module for the reason `definition-routes.ts` is: `routes.ts` is long, and this endpoint is
// the one place in the app where a file somebody else produced becomes something the app will state as
// fact. That deserves to be readable in one screen without the rest of the API around it.
//
// The pipeline is four modules deep and the order is the point, because each one narrows what the next
// is allowed to assume:
//
//   `read.ts`      bytes, under a cap, as strict UTF-8 — the only layer that sees the wire
//   `parse.ts`     text to a value, refusing depth, duplicate keys and polluted prototypes
//   `envelope.ts`  a value to a typed `Envelope`, or a refusal naming the field
//   `trust.ts`     whether a well-formed envelope may be believed here and now
//
// Nothing is written until all four pass, so a refused upload leaves the app exactly as it was. That
// matters more than it sounds: the failure mode this endpoint exists to prevent is a stale or foreign
// reading becoming a finding, and a half-import is the shape that would do it.
//
// The status codes are chosen to be actionable rather than merely correct. A malformed file is a 400
// because the sender can fix it; a well-formed file the app declines to believe is a 422, because
// nothing about the request is wrong and re-sending it will not help; a replay is a 409, because the
// state of the server is the reason.

import type { Application, Request, Response } from 'express';
import type {
  EvidenceImportPayload,
  EvidenceImportVerdictPayload,
  EvidenceImportsPayload,
  EvidenceNotePayload,
} from '../../shared/api/contract.js';
import { UnreadableBodyError, readUploaded } from '../import/read.js';
import { UnsafeJsonError, parseUntrusted } from '../import/parse.js';
import { MalformedEnvelopeError, envelopeFrom, type Envelope } from '../import/envelope.js';
import { MAX_AGE_DAYS, REPLAYED, assess, type Note, type Target, type TrustVerdict } from '../import/trust.js';
import {
  ReplayedImportError,
  summaryOf,
  type EvidenceImportStore,
  type ImportedEvidence,
  type ImportedEvidenceSummary,
} from '../import/store.js';
import type { ScanStore } from '../scan/store.js';
import type { Act } from '../audit/record.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';

export interface ImportRouteOptions {
  /** Where accepted collections are kept. Absent means the app cannot hold one and says so. */
  readonly imports?: EvidenceImportStore;
  /**
   * Read for what this app believes it is assessing.
   *
   * The last scan's estate is the only place the workspace set is known, which is why the target is
   * derived per request rather than held: a scan run between two uploads changes what the second one
   * is held against, and the newer answer is the right one.
   */
  readonly store: ScanStore;
  /** Establishes that the caller may change something, or throws, and opens the act for the log. */
  readonly permitted: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly target?: AuditTarget }
  ) => Promise<{ readonly actor: string; readonly act: Act }>;
  /** Turns a thrown cause into the response it deserves. */
  readonly respondToFailure: (response: Response, cause: unknown) => void;
  /**
   * The digest of the script this app publishes, for comparison with the one that collected.
   *
   * A function rather than a value because the script is loaded lazily, and undefined rather than
   * required because an install that cannot read its own copy should still accept evidence — it just
   * cannot say whether the collecting copy was this one.
   */
  readonly publishedScriptDigest?: () => string | undefined;
  /** Injected so a test can pin the import's timestamp and the age of what it is judging. */
  readonly now?: () => Date;
}

const NO_STORE =
  'This install has nowhere to keep imported evidence, so a file cannot be accepted: it would ' +
  'answer requirements on this page and be gone on the next restart, which is worse than not ' +
  'having answered them. Bind a Lakebase instance to the app and the import becomes available.';

function noteOf<Reason extends string>(note: Note<Reason>): EvidenceNotePayload {
  return { reason: note.reason, message: note.message };
}

export function presentImport(imported: ImportedEvidenceSummary): EvidenceImportPayload {
  const { summary } = imported;

  return {
    digest: imported.digest,
    generatedAt: summary.generatedAt,
    importedAt: imported.importedAt.toISOString(),
    importedBy: imported.importedBy,
    ...(summary.collectedBy != null ? { collectedBy: summary.collectedBy } : {}),
    workspaceTier: summary.workspaceTier,
    accountTier: summary.accountTier,
    observed: summary.observed,
    refused: summary.refused,
    requirements: summary.requirements,
    scriptVersion: summary.scriptVersion,
    cautions: imported.cautions.map(noteOf),
  };
}

/**
 * What the app believes it is assessing, from the last scan.
 *
 * Absent workspace ids rather than an empty list when no scan has run, because the two mean opposite
 * things to `trust.ts`: an empty list is "this assessment covers no workspaces", which would refuse
 * every file, and absence is "the app does not know yet", which cautions instead. The distinction is
 * the reason this returns a `Target` with optional members rather than arrays with defaults.
 *
 * A read failure is treated as not knowing rather than propagated. The store being unavailable is not
 * a reason to refuse evidence; it is a reason to be unable to confirm the file is about this estate,
 * which is exactly what the unverified caution says.
 */
async function targetFrom(store: ScanStore): Promise<Target> {
  try {
    const latest = await store.latest();
    const assessed = latest?.estate?.assessed ?? [];
    if (assessed.length === 0) return {};
    return { workspaceIds: assessed.map((workspace) => workspace.id) };
  } catch {
    return {};
  }
}

function verdictOf(verdict: TrustVerdict, imported?: ImportedEvidence): EvidenceImportVerdictPayload {
  return {
    accepted: imported != null,
    refusals: verdict.refusals.map(noteOf),
    cautions: verdict.cautions.map(noteOf),
    ...(imported != null ? { imported: presentImport(summaryOf(imported)) } : {}),
  };
}

export function registerImportRoutes(app: Application, options: ImportRouteOptions): void {
  const now = options.now ?? ((): Date => new Date());

  app.get('/api/evidence/imports', async (_request, response) => {
    const store = options.imports;
    if (store == null) {
      // 200 rather than 503, because "nowhere to keep one" is a true and complete answer to "what do
      // you hold". The page needs it to explain why the upload is unavailable, and an error status
      // would have it render a failure instead of the explanation.
      const empty: EvidenceImportsPayload = { durable: false, imports: [], acceptedForDays: MAX_AGE_DAYS };
      response.json(empty);
      return;
    }

    // `summaries` rather than `all`: this page shows what is held and never a probe, and the envelopes
    // are the one thing in this table stored out of line. Row 85 measured the difference.
    const held = await store.summaries();
    const payload: EvidenceImportsPayload = {
      durable: store.durable,
      imports: held.map(presentImport),
      acceptedForDays: MAX_AGE_DAYS,
    };
    response.json(payload);
  });

  app.post('/api/evidence/imports', async (request, response) => {
    const store = options.imports;
    if (store == null) {
      response.status(503).json({ error: 'imports-unavailable', message: NO_STORE });
      return;
    }

    let actor: string;
    let act: Act;
    try {
      // Gated before the body is read. An unauthorised caller should not be able to make this process
      // buffer eight megabytes, and reading first would mean they could.
      ({ actor, act } = await options.permitted(request, response, 'evidence.import'));
    } catch (cause) {
      options.respondToFailure(response, cause);
      return;
    }

    let envelope: Envelope;
    try {
      // Assignable rather than cast: `Uploaded` names the three members this needs, and an Express
      // request satisfies them structurally. See `read.ts` for why the narrow type exists.
      const text = await readUploaded(request);
      envelope = envelopeFrom(parseUntrusted(text));
    } catch (cause) {
      // Recorded with the reason each of these carries, which is this app's own word for what was
      // wrong with the file, rather than the error class. `too-large` and `unparseable` are different
      // problems to chase and both are `UnreadableBodyError`.
      await act.failed(
        cause instanceof UnreadableBodyError ||
          cause instanceof UnsafeJsonError ||
          cause instanceof MalformedEnvelopeError
          ? cause.reason
          : cause
      );

      if (cause instanceof UnreadableBodyError) {
        // 413 for a body over the cap, 415 for the wrong content type, 400 for the rest. Each is the
        // status a caller's own tooling knows how to report, which matters because half the callers
        // here are curl rather than this app's page.
        const status = cause.reason === 'too-large' ? 413 : cause.reason === 'wrong-content-type' ? 415 : 400;
        response.status(status).json({ error: cause.reason, message: cause.message });
        return;
      }
      if (cause instanceof UnsafeJsonError) {
        response.status(400).json({ error: cause.reason, message: cause.message });
        return;
      }
      if (cause instanceof MalformedEnvelopeError) {
        response.status(400).json({ error: cause.reason, message: cause.message, at: cause.at });
        return;
      }
      options.respondToFailure(response, cause);
      return;
    }

    const verdict = assess({
      envelope,
      target: await targetFrom(options.store),
      imported: await store.digests(),
      ...(options.publishedScriptDigest?.() != null ? { publishedScriptDigest: options.publishedScriptDigest() } : {}),
      now: now(),
    });

    if (!verdict.trusted) {
      // A failure rather than a refusal: `refused` is the gate turning a caller away, and this caller
      // was permitted. The app declined to believe the file, which is the thing an auditor is looking
      // for on this route — "somebody uploaded evidence and it was not accepted, and here is why".
      await act.failed(verdict.refusals[0]?.reason ?? 'untrusted', { kind: 'evidence', id: verdict.digest });

      // 409 when the only thing wrong is that the server already holds it, since that is a statement
      // about state rather than about the request. Everything else is a 422: the request is
      // well-formed and the app declines to believe it, and re-sending will not change that.
      const replayed = verdict.refusals.some((refusal) => refusal.reason === 'replayed');
      response.status(replayed ? 409 : 422).json(verdictOf(verdict));
      return;
    }

    const imported: ImportedEvidence = {
      digest: verdict.digest,
      generatedAt: new Date(Date.parse(envelope.generatedAt)),
      importedAt: now(),
      importedBy: actor,
      envelope,
      cautions: verdict.cautions,
    };

    try {
      await store.record(imported);
      await act.performed({ kind: 'evidence', id: imported.digest });
    } catch (cause) {
      await act.failed(cause instanceof ReplayedImportError ? 'replayed' : cause, {
        kind: 'evidence',
        id: imported.digest,
      });
      if (cause instanceof ReplayedImportError) {
        // Reachable despite the check above, because two uploads of one file can race between the
        // digest read and the insert. The index is what actually enforces it; this turns the violation
        // into the same answer the check would have given — the same shape as well as the same
        // sentence, because the page parses every 409 as a verdict and reads its refusals. An
        // `{ error, message }` here would crash the one screen on the one path this exists to handle.
        const raced = { ...verdict, trusted: false, refusals: [...verdict.refusals, REPLAYED] };
        response.status(409).json(verdictOf(raced));
        return;
      }
      options.respondToFailure(response, cause);
      return;
    }

    response.status(201).json(verdictOf(verdict, imported));
  });
}
