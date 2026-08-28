// What this install can reach, on one page.
//
// # Why this is not gated
//
// For the reason the trail is not: the person who needs it is the person fixing a half-bound install,
// and the group that permits changes to an assessment is not the group that binds resources. An admin
// who has just added a warehouse and wants to know whether the app can see it should not have to be
// an assessor first, and the sentence they need — "no database is bound" — is one this app already
// says on four other pages to anybody who opens them.
//
// What that constrains is what may be in here, and the constraint is taken seriously: no schema
// contents, no estate data, no identifiers beyond the warehouse id the workspace already shows in the
// resource binding. And nothing in here spends the customer's money, which is the whole reason the
// warehouse reading is observed rather than probed — see `health.ts`.
//
// # Why it is not `/health`
//
// A path a platform probe would find. This app's liveness is AppKit's business and the fallback
// server's, and a monitor that started polling this one would take an identity probe with every
// poll. `/api/diagnostics` says who it is for: a person reading, once, while something is wrong.

import type { Application, Response } from 'express';
import type { DiagnosticsPayload, ReadingPayload } from '../../shared/api/contract.js';
import { readHealth, type HealthSources, type Reading } from '../health/health.js';

export interface HealthRouteOptions {
  /**
   * What to read, composed per request rather than once at boot.
   *
   * A function of the request because two of the four readings depend on it: the identity probe needs
   * the caller's forwarded token, and there is no other authority to ask with. The rest could have
   * been captured at boot and are not, because a reading taken at boot and served an hour later is
   * the overclaim this whole module is arranged to avoid.
   */
  readonly sourcesFor: (request: {
    readonly headers: NodeJS.Dict<string | string[]>;
  }) => HealthSources | Promise<HealthSources>;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
}

function readingOf(reading: Reading): ReadingPayload {
  return {
    dependency: reading.dependency,
    standing: reading.standing,
    provenance: reading.provenance,
    at: reading.at.toISOString(),
    detail: reading.detail,
    ...(reading.action != null ? { action: reading.action } : {}),
  };
}

export function registerHealthRoutes(app: Application, options: HealthRouteOptions): void {
  app.get('/api/diagnostics', async (request, response) => {
    try {
      const health = await readHealth(await options.sourcesFor(request));
      const payload: DiagnosticsPayload = {
        at: health.at.toISOString(),
        well: health.well,
        unrecorded: health.unrecorded,
        readings: health.readings.map(readingOf),
      };
      response.json(payload);
    } catch (cause) {
      // `readHealth` catches each probe into its own reading, so reaching here means the composition
      // itself broke rather than a dependency. Which is worth a 500 rather than a page that reports
      // everything as unknown: the second would look like a diagnosis and be the absence of one.
      options.respondToFailure(response, cause);
    }
  });
}
