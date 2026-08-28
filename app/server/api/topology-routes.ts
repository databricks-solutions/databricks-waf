// The estate graph, as one payload.
//
// Ungated like every other read. The statements run as the signed-in user,
// where a warehouse is bound. An install still being set up has none, and
// this answers 503 with that sentence rather than an empty graph — empty is
// a fact about an estate, and a missing warehouse is not one.
//
// The window is the default thirty days, not one the caller sends. A reader
// who could set it could choose the 2,000 newest edges of a year, and the
// canvas would not say so. 101e applies the 2,000-edge cap; which 2,000 is
// newest `lastSeen`.

import type { Application, Request, Response } from 'express';

import type { TopologyPayload } from '../../shared/api/topology.js';
import type { CollectedTopology } from '../collect/topology/collector.js';
import { topologyPayload } from '../collect/topology/payload.js';

export interface TopologyRouteOptions {
  /**
   * The seven drawn relations, for one request, or absent where nothing can run them.
   *
   * A factory per request: the statements run as the signed-in user. Absent where
   * no warehouse is bound.
   */
  readonly collect?: (request: Request, signal: AbortSignal) => Promise<CollectedTopology>;
  readonly respondToFailure: (response: Response, cause: unknown) => void;
}

const NO_WAREHOUSE =
  'No SQL warehouse is bound to this installation, so the seven statements this graph is made of cannot run. Bind one and open this page again.';

export function registerTopologyRoutes(app: Application, options: TopologyRouteOptions): void {
  app.get('/api/topology', async (request, response) => {
    if (options.collect == null) {
      response.status(503).json({ error: 'topology-unavailable', message: NO_WAREHOUSE });
      return;
    }

    const controller = new AbortController();
    const abandon = () => controller.abort();
    request.once('aborted', abandon);
    response.once('close', abandon);

    try {
      const collected = await options.collect(request, controller.signal);
      const payload: TopologyPayload = topologyPayload(collected.edges, collected.names);
      response.json(payload);
    } catch (cause) {
      options.respondToFailure(response, cause);
    } finally {
      request.off('aborted', abandon);
      response.off('close', abandon);
    }
  });
}
