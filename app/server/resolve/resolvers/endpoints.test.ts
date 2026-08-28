// Half-readable controls, and the claim that half a reading is worth taking.
//
// SCP-03-07 is the case worth defending. The app can list serving endpoints and cannot see the
// network controls in front of them, and the easy handling — report the whole thing unmeasured —
// discards the half that decides whether the requirement applies at all. These tests hold the
// three-way split: no endpoints is not-applicable, endpoints is an open question, and the open
// question carries the endpoint names so the person answering it knows what they are answering
// about. Also that neither resolver ever claims the protection is present.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { ServingInventory, VectorSearchInventory } from '../../collect/rest/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const SERVING = 'rest:workspace:serving-endpoints' as SignalId;
const VECTOR_SEARCH = 'rest:workspace:vector-search.endpoints' as SignalId;
const catalogue = loadCatalogue();
const registry = buildRegistry();

function findingFor(controlId: string, signal: SignalId, value: unknown) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  const signals = new Map<SignalId, SignalResult>([[signal, observed(signal, value, 1, { mode: 'complete' })]]);
  return resolveControl(spec, signals, registry.get(controlId));
}

function serving(...names: string[]): ServingInventory {
  return {
    endpoints: names.map((name) => ({ name, servedExternalModel: false, state: 'READY' })),
    truncated: false,
  };
}

function vectorSearch(...names: string[]): VectorSearchInventory {
  return {
    endpoints: names.map((name) => ({ name, type: 'STANDARD', state: 'ONLINE' })),
    truncated: false,
  };
}

describe('SCP-02-09, embeddings in a governed store', () => {
  it('passes an estate using Databricks Vector Search', () => {
    const finding = findingFor('SCP-02-09', VECTOR_SEARCH, vectorSearch('product-search'));

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('product-search');
  });

  it('does not claim every embedding in the estate is governed', () => {
    // A pass on presence, which is what the requirement asks. An index built on a cluster or in
    // an external vector database is invisible from the control plane, and a finding that read
    // as "all embeddings are governed" would be asserting something the app cannot see.
    const finding = findingFor('SCP-02-09', VECTOR_SEARCH, vectorSearch('one'));
    expect(finding.outcomeReason).toContain('not a claim that');
  });

  it('says the requirement does not apply when nothing does vector search, and says why that is not a pass', () => {
    const finding = findingFor('SCP-02-09', VECTOR_SEARCH, vectorSearch());

    expect(finding.outcome).toBe('not-applicable');
    // The reason has to name the blind spot. An estate keeping embeddings in an external store
    // reads as "no endpoints" here, and reporting that as nothing-to-see would hide the exact
    // situation the requirement exists for.
    expect(finding.outcomeReason).toContain('needs an answer rather than a scan');
  });
});

describe('SCP-03-07, serving endpoints off the public internet', () => {
  it('says the requirement does not apply when nothing is served', () => {
    // Worth having rather than reporting unmeasured: an estate with no endpoints cannot have
    // unprotected endpoints, so this leaves the denominator instead of looking like a gap.
    const finding = findingFor('SCP-03-07', SERVING, serving());

    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('returns as soon as an endpoint is created');
  });

  it('reports an open question when endpoints exist, never a verdict on the protection', () => {
    const finding = findingFor('SCP-03-07', SERVING, serving('fraud-model', 'ranker'));

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('networking');
    expect(finding.outcomeReason).toContain('account-plane');
    // Unreachable rather than unreadable: the protection is observable and this app will never be
    // allowed to observe it. Reported as a source the scan could not read, this would send a
    // workspace admin hunting for a grant that does not exist.
    expect(finding.unmeasured).toBe('unreachable');
    expect(finding.remedy?.kind).toBe('attest');
  });

  it('names the endpoints in evidence, so the question is about something specific', () => {
    // The reason this control reads the endpoint list at all. Asked whether their serving
    // endpoints are protected, an admin needs to know which endpoints those are.
    const finding = findingFor('SCP-03-07', SERVING, serving('fraud-model', 'ranker'));

    expect(finding.evidence).toHaveLength(1);
    expect(finding.evidence[0]?.observed).toContain('fraud-model');
    expect(finding.evidence[0]?.observed).toContain('ranker');
    expect(finding.evidence[0]?.observed).toContain('2 model serving endpoints');
  });

  it('counts one endpoint in the singular', () => {
    expect(findingFor('SCP-03-07', SERVING, serving('only')).evidence[0]?.observed).toContain(
      '1 model serving endpoint:'
    );
  });
});
