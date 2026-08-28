// Two controls about served-model endpoints, and one of them is a lesson about applicability.
//
// SCP-02-09 is measurable and SCP-03-07 is half measurable, and the halves matter. Both name an
// endpoint listing this app can call — `vector-search` and `model-serving` are the only two of the
// security pillar's control-plane scopes the platform grants an app (ADR 0016) — but SCP-03-07
// then asks whether those endpoints are shielded by IP access lists or Private Link, which needs
// `networking` and the account plane. Neither is available to any install.
//
// The naive handling of a half-readable control is to report it unmeasured and move on. That
// throws away the readable half, and the readable half is the more useful one here: an estate with
// no serving endpoints cannot have unprotected serving endpoints, so the requirement does not
// apply and the control leaves the denominator honestly rather than sitting in the unmeasured pile
// looking like a gap. Only an estate that *does* have endpoints has an open question, and then the
// question is precise — these named endpoints exist and the app cannot see what fronts them —
// which is a far better prompt for an answer than "not measured".
//
// So: read what is readable, decide applicability with it, and hand over only the part that is
// genuinely beyond reach.

import type { ControlResolver } from '../resolver.js';
import type { ServingInventory, VectorSearchInventory } from '../../collect/rest/shapes.js';
import { evidenceFrom, fromSignal, notApplicable, unmeasured } from './helpers.js';

const SERVING = 'rest:workspace:serving-endpoints';
const VECTOR_SEARCH = 'rest:workspace:vector-search.endpoints';

/**
 * SCP-02-09: embeddings held in a governed store.
 *
 * A vector index is a copy of the text it was built from, so an embedding store outside Unity
 * Catalog holds derivatives of governed data under no grants at all. Databricks Vector Search
 * indexes are UC objects; a self-managed store on a cluster is not, and the difference is
 * invisible in a notebook.
 *
 * The control asks whether at least one endpoint is configured, so it is a positive check rather
 * than a violation count. That makes the empty case the interesting one, and it is not a failure:
 * an estate doing no vector search has nothing to govern.
 */
const embeddingStore = fromSignal<VectorSearchInventory>(VECTOR_SEARCH, ['SCP-02-09'], (inventory, context) => {
  if (inventory.endpoints.length === 0) {
    return notApplicable(
      'There are no Databricks Vector Search endpoints in this workspace, so there is no managed embedding ' +
        'store to assess. This does not rule out embeddings held somewhere else — a self-managed index on a ' +
        'cluster or an external vector database is invisible from here, and is the thing this requirement is ' +
        'really about. If that is how embeddings are stored, the requirement needs an answer rather than a scan.'
    );
  }

  const ready = inventory.endpoints.filter((endpoint) => endpoint.state == null || endpoint.state === 'ONLINE');

  return {
    outcome: 'pass',
    evidence: [
      evidenceFrom(
        context,
        VECTOR_SEARCH,
        `${inventory.endpoints.length} Databricks Vector Search endpoint${inventory.endpoints.length === 1 ? '' : 's'}` +
          ` (${String(ready.length)} online): ${inventory.endpoints.map((endpoint) => endpoint.name).slice(0, 5).join(', ')}`,
        'Embeddings are held in Databricks Vector Search, whose indexes are Unity Catalog objects and carry its grants'
      ),
    ],
    outcomeReason:
      'A pass on the presence of a governed store, which is what the requirement asks. It is not a claim that ' +
      'every embedding in the estate is in it: an index built outside Databricks would not appear here, and ' +
      'nothing in the control plane would reveal it.',
  };
});

/**
 * SCP-03-07: serving endpoints kept off the public internet.
 *
 * The endpoint list is readable and the protection in front of it is not, so this resolves to one
 * of two things and never to a verdict on the protection. No endpoints means the requirement does
 * not apply. Endpoints means an open question, with the endpoints named so the person answering it
 * knows exactly what they are being asked about.
 */
const servingExposure = fromSignal<ServingInventory>(SERVING, ['SCP-03-07'], (inventory, context) => {
  if (inventory.endpoints.length === 0) {
    return notApplicable(
      'There are no model serving endpoints in this workspace, so there is no serving surface exposed to the ' +
        'internet. The requirement returns as soon as an endpoint is created.'
    );
  }

  const named = inventory.endpoints.map((endpoint) => endpoint.name).slice(0, 5).join(', ');

  return {
    ...unmeasured(
      // Diagnosis only: what applies, and what could not be read. What to do about it is the
      // remedy's, and the two render a few inches apart — this sentence used to end "So the
      // requirement is answered by attestation", which the advice below it then said again.
      `This workspace serves ${String(inventory.endpoints.length)} model endpoint` +
        `${inventory.endpoints.length === 1 ? '' : 's'}, so the requirement applies. Whether they are shielded ` +
        'cannot be read: an IP access list needs the "networking" scope and Private Link is account-plane ' +
        'configuration, and Databricks Apps offers an app neither.',
      // `unreachable`, not `unreadable`. The protection is observable — the app is simply not
      // allowed to observe it, and never will be. Filing this under sources the scan could not
      // read would send a workspace admin looking for a grant to issue that does not exist.
      'unreachable'
    ),
    // Evidence on an unmeasured finding, which is unusual and is the point: what the app *did*
    // read is what makes the question answerable. Without it the reader is asked whether their
    // serving endpoints are protected without being told which endpoints those are.
    evidence: [
      evidenceFrom(
        context,
        SERVING,
        `${inventory.endpoints.length} model serving endpoint${inventory.endpoints.length === 1 ? '' : 's'}: ${named}`,
        'Serving endpoints are reachable only over Private Link or from an allowed IP range'
      ),
    ],
  };
});

export const ENDPOINT_RESOLVERS: readonly ControlResolver[] = [embeddingStore, servingExposure];
