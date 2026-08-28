// The HTTP surface for what a customer serves, and how ready it is.
//
// Three endpoints. Two reads, ungated like every other read here, and one write behind the same gate
// as every other change — `A1a`'s rule, and this is a new mutating endpoint, so it is authorized by
// the shared `permitted` rather than by anything of its own.
//
// # Why the readiness read runs statements and the declaration read does not
//
// A declaration is a record this app keeps. Readiness is a reading of the customer's estate taken
// against that record, and it cannot be cached into the record without becoming a number whose date
// nobody can see. So `GET /api/foundation/readiness` executes three statements against the warehouse,
// every time, and says which of them did not answer.
//
// That is a warehouse cost on a page load, which is unusual here and is bounded on purpose: the three
// statements are bounded to the declared population rather than to the estate, which is the whole
// argument of `45c` and the thing `61` exists because `uc_discovery_metadata` does not do. An install
// that has declared nothing runs no statement at all.
//
// # What this surface will not do
//
// There is no endpoint that returns a readiness score, and no field on the payload that could become
// one. The eight dimensions are shares of eight different populations, each carrying its own
// denominator, and the module that produces them refuses to add them — see `readiness.ts`, which
// records the measurement that settled it. A total here would be that refusal undone one layer up,
// where nothing checks it.

import type { Application, Request, Response } from 'express';

import type {
  FoundationReadinessPayload,
  ReadinessDimensionPayload,
  ServingDeclarationPayload,
} from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import { ServingDefinitionError, type ServingDraft } from '../foundation/serving-asset.js';
import type { ServingDeclaration, ServingStore } from '../foundation/serving-store.js';
import { nextDeclaration, ServingVersionError } from '../foundation/serving-store.js';
import type { ServingSql } from '../foundation/readiness-read.js';
import { readReadiness } from '../foundation/readiness-read.js';
import { dimensionLanguage } from '../foundation/readiness-language.js';
import type { ReadinessOutcome } from '../foundation/readiness.js';
import { absences } from '../foundation/readiness.js';
import { assessmentOf } from './assessment-query.js';

export interface FoundationRouteOptions {
  /** Absent means declarations are not kept, and the routes say so rather than losing one. */
  readonly serving?: ServingStore;
  /** What this install does about keeping them, in the reader's terms. */
  readonly servingStorage?: string;
  /**
   * The three statements, for one request, or absent where nothing can run them.
   *
   * A factory per request rather than one executor, for `routes.ts`'s reason about every other read:
   * the statements run as the signed-in user, so the credentials are the request's. Absent where no
   * warehouse is bound, and the readiness read then answers `unavailable` with that as the reason
   * rather than failing — an install still being set up has no warehouse and has done nothing wrong.
   */
  readonly servingSql?: (request: Request) => Promise<ServingSql>;
  readonly permitted: (
    request: Request,
    response: Response,
    action: AuditAction,
    context?: { readonly target?: AuditTarget }
  ) => Promise<{ readonly actor: string; readonly act: Act }>;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
  readonly now?: () => Date;
}

const NO_STORE =
  'This installation is not keeping serving declarations, so there is nowhere to put one. Bind a ' +
  'database and restart, and what somebody declares will survive a deploy.';

const NOT_DURABLE =
  'Serving declarations are being kept in memory on this installation, so a restart loses them. A ' +
  'readiness reading is a reading of a declaration — bind a database before relying on either.';

const NO_WAREHOUSE =
  'No SQL warehouse is bound to this installation, so the three statements this reading is made of ' +
  'cannot run. Bind one and open this page again.';

export function registerFoundationRoutes(app: Application, options: FoundationRouteOptions): void {
  const now = options.now ?? (() => new Date());

  /** The current declaration, or that there is none. Never a 404: no declaration is an answer. */
  app.get('/api/foundation/serving', async (request, response) => {
    const store = options.serving;
    if (store == null) {
      response.json({ declaration: null, durable: false, durabilityNote: NO_STORE });
      return;
    }

    try {
      const current = await store.current(assessmentOf(request));
      response.json({
        declaration: current == null ? null : declared(current),
        durable: store.durable,
        ...(store.durable ? {} : { durabilityNote: options.servingStorage ?? NOT_DURABLE }),
      });
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });

  /**
   * Declares the next version, or refuses one that is not the next.
   *
   * The version is read here rather than sent, so two people declaring from the same page collide on
   * the store's constraint instead of one silently replacing the other. What comes back on a collision
   * is 409 and the version that is current, which is the only thing the loser can act on.
   */
  app.post('/api/foundation/serving', async (request, response) => {
    const store = options.serving;
    if (store == null) {
      response.status(503).json({ error: 'serving-unavailable', message: NO_STORE });
      return;
    }

    let act: Act | undefined;
    try {
      // Before the body is read, like every other mutation here: a declaration nobody is permitted to
      // make should not be validated first.
      const permission = await options.permitted(request, response, 'serving.declare');
      const { actor } = permission;
      act = permission.act;

      const scope = assessmentOf(request);
      const previous = await store.current(scope);
      const declaration = nextDeclaration(request.body as ServingDraft, previous, actor, now(), scope ?? undefined);

      await store.declare(declaration);
      await act.performed({ kind: 'serving', id: String(declaration.version) });
      response.status(201).json(declared(declaration));
    } catch (cause) {
      await act?.failed(cause);
      respond(response, cause, options);
    }
  });

  /**
   * Eight readings of the declared population, taken now.
   *
   * 200 in every case a reader can do something about, including the three that are not readings: no
   * declaration, no warehouse, and a statement that did not answer. A page that failed to load says
   * less than one that explains which of those happened.
   */
  app.get('/api/foundation/readiness', async (request, response) => {
    const store = options.serving;

    try {
      const current = store == null ? undefined : await store.current(assessmentOf(request));
      const definition = current?.definition ?? null;

      if (options.servingSql == null && definition != null) {
        response.json(unavailable(current, NO_WAREHOUSE, store?.durable === true, options));
        return;
      }

      // With nothing declared, the read runs no statement, so the absent factory is enough to satisfy
      // it. `readReadiness` is still what produces the outcome: the undeclared payload a reader sees
      // is the module's own, not a second version of it composed here.
      const sql = options.servingSql == null ? refusing() : await options.servingSql(request);
      const reading = await readReadiness(definition, sql);

      response.json({
        declaration: current == null ? null : declared(current),
        population: reading.outcome.population,
        dimensions: reading.outcome.dimensions.map(dimensionOf),
        absent: reading.outcome.absent,
        unread: reading.unread,
        durable: store?.durable === true,
        ...(store?.durable === true ? {} : { durabilityNote: options.servingStorage ?? NOT_DURABLE }),
      } satisfies FoundationReadinessPayload);
    } catch (cause) {
      options.respondToFailure(response, cause);
    }
  });
}

/**
 * A reading nobody could take, with the dimensions still named.
 *
 * Named rather than an empty list, because the eight are what the page is: a reader who arrives to a
 * page with no dimensions on it learns that something is broken, and a reader who arrives to eight
 * unmeasured ones and a sentence learns what to bind.
 */
function unavailable(
  declaration: ServingDeclaration | undefined,
  because: string,
  durable: boolean,
  options: FoundationRouteOptions
): FoundationReadinessPayload {
  return {
    declaration: declaration == null ? null : declared(declaration),
    population: { assets: 0, missing: 0, truncated: false, undeclared: declaration == null },
    dimensions: [],
    absent: absences(),
    unread: [],
    unavailable: because,
    durable,
    ...(durable ? {} : { durabilityNote: options.servingStorage ?? NOT_DURABLE }),
  };
}

/** Five statements that cannot run, for the undeclared case where none of them is called. */
function refusing(): ServingSql {
  const no = () => Promise.reject(new Error(NO_WAREHOUSE));
  return { population: no, tags: no, facts: no, quality: no, classes: no };
}

/**
 * A declaration on the wire, field by field rather than spread.
 *
 * Written out for `note-routes.ts`'s reason: the domain type and the payload are structurally alike
 * today and are allowed to stop being, and a spread would put a new domain field on the wire the day
 * somebody adds one. Here that matters more than usual — the fingerprint is over the definition, and a
 * payload carrying a field the fingerprint does not cover would be showing a reader something the
 * version cannot account for.
 */
function declared(declaration: ServingDeclaration): ServingDeclarationPayload {
  const { definition } = declaration;
  return {
    ...(declaration.definitionId != null ? { definitionId: declaration.definitionId } : {}),
    version: declaration.version,
    declaredAt: declaration.declaredAt.toISOString(),
    declaredBy: declaration.declaredBy,
    fingerprint: definition.fingerprint,
    named: definition.named.map((name) => ({ catalog: name.catalog, schema: name.schema, table: name.table })),
    tagged: definition.tagged.map((selector) => ({
      key: selector.key,
      // Absent stays absent. Rendered as an empty list, a selector that matches any value of the key
      // would read as one that matches none, which is the opposite claim about what is served.
      ...(selector.values != null ? { values: [...selector.values] } : {}),
      at: [...selector.at],
    })),
    requiredTagKeys: [...definition.requiredTagKeys],
    requiredMetadata: [...definition.requiredMetadata],
    policy: definition.policy.map((rule) => ({
      classification: rule.classification,
      requires: [...rule.requires],
    })),
  };
}

function dimensionOf(reading: ReadinessOutcome['dimensions'][number]): ReadinessDimensionPayload {
  const language = dimensionLanguage(reading.id);
  return {
    id: reading.id,
    version: reading.version,
    area: language.area,
    label: language.label,
    asks: language.asks,
    sources: language.sources,
    standing: reading.standing,
    bands: reading.bands,
    denominator: reading.denominator,
    met: reading.met,
    short: reading.short,
    unmeasured: reading.unmeasured,
    share: reading.share,
    ...(reading.because != null ? { because: reading.because } : {}),
    shortfall: reading.shortfall,
  };
}

function respond(response: Response, cause: unknown, options: FoundationRouteOptions): void {
  if (cause instanceof ServingDefinitionError) {
    response.status(400).json({ error: 'invalid-declaration', message: cause.message });
    return;
  }
  if (cause instanceof ServingVersionError) {
    // 409 rather than 400: nothing about the declaration is wrong, and the caller's next move is to
    // re-read and decide rather than to correct what they sent.
    response.status(409).json({ error: 'stale-declaration', message: cause.message });
    return;
  }
  options.respondToFailure(response, cause);
}
