// Which kind of unknown a control is, decided in the one place every finding passes through.
//
// The three kinds lead to three different actions — ask the customer, build the check, fix
// the access — and getting them the wrong way round is worse than not distinguishing them
// at all. Labelling our unwritten check as an attestation asks the customer to vouch for
// something the app should have measured; labelling a practice statement as unreadable
// tells them their permissions are wrong when they are not.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { resolveControl, type ControlResolver, type ControlSpec } from './resolver.js';
import { buildRegistry } from './resolvers/index.js';
import type { SignalId, SignalResult } from '../collect/signal.js';

const NO_SIGNALS = new Map<SignalId, SignalResult>();
const CATALOGUE = loadCatalogue();
const REGISTRY = buildRegistry();

function observed(id: SignalId, value: unknown): SignalResult {
  return { id, status: 'observed', value, collectedAt: new Date(), coverage: { mode: 'complete' }, durationMs: 1 };
}

function spec(overrides: Partial<ControlSpec> = {}): ControlSpec {
  return {
    id: 'X-01-01',
    pillarId: 'reliability',
    principleId: 'reliability-01',
    title: 'A control',
    severity: 'medium',
    ...overrides,
  };
}

/** A resolver that runs and cannot decide, which is the third case. */
function cannotDecide(): ControlResolver {
  return {
    controls: ['X-01-01'],
    requires: [],
    resolve: () => ({
      outcome: 'unmeasurable',
      evidence: [],
      outcomeReason: 'The source held no rows.',
    }),
  };
}

describe('classifying an unknown', () => {
  it('calls a practice statement an attestation, because only a person can answer it', () => {
    const finding = resolveControl(spec({ measurability: 'attestation' }), NO_SIGNALS, undefined);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('attestation');
  });

  it('calls a measurable control with no resolver unbuilt, not an attestation', () => {
    // The distinction that matters most: this is our unfinished work, and presenting it as
    // a question for the customer would be passing the buck.
    const finding = resolveControl(
      spec({ measurability: 'system-table', evaluatorStatus: 'planned' }),
      NO_SIGNALS,
      undefined
    );

    expect(finding.unmeasured).toBe('unbuilt');
    expect(finding.outcomeReason).toContain('planned but not implemented');
  });

  it('calls it unbuilt even when the catalogue says nothing about status', () => {
    expect(resolveControl(spec({ measurability: 'rest-api' }), NO_SIGNALS, undefined).unmeasured).toBe('unbuilt');
  });

  it('calls a resolver that ran and could not decide unreadable', () => {
    const finding = resolveControl(spec({ measurability: 'system-table' }), NO_SIGNALS, cannotDecide());

    expect(finding.unmeasured).toBe('unreadable');
    expect(finding.outcomeReason).toContain('no rows');
  });

  it('calls a scope no install can be granted unreachable, not a source it could not read', () => {
    // Caught on a live scheduled run, where it cost the operator the wrong afternoon. Of 80
    // requirements reported as unread, 18 were calls Databricks Apps offers no scope for at all —
    // filed under "sources the scan could not read", which reads as a grant to go and issue.
    // Nothing an admin does closes these. They are the same gap as an attestation and belong with
    // the 37 the platform will not authorise, not with the ones a grant would fix.
    const settings = 'rest:workspace.conf' as SignalId;
    const refusedTheScope: ControlResolver = {
      controls: ['X-01-01'],
      requires: [settings],
      resolve: () => ({ outcome: 'unmeasurable', evidence: [] }),
    };
    const signals = new Map<SignalId, SignalResult>([
      [
        settings,
        {
          id: settings,
          status: 'unmeasurable',
          coverage: { mode: 'complete' },
          unmeasurableReason: 'Provided OAuth token does not have required scopes: settings',
          collectedAt: new Date(),
          durationMs: 1,
        },
      ],
    ]);

    // The collector names the endpoint, which is what the family table is a statement about: ADR
    // 0016 probed `preview.workspace-conf` against the registry and recorded "settings" as a scope
    // no app may request.
    const finding = resolveControl(
      spec({ measurability: 'rest-api', collector: 'rest:workspace:preview.workspace-conf' }),
      signals,
      refusedTheScope
    );

    expect(finding.remedy?.kind).toBe('attest');
    expect(finding.unmeasured).toBe('unreachable');
  });

  it('still calls a stale consent unreadable, because one sign-in closes it', () => {
    // The other side of the line above, and the reason it is drawn on the refusal rather than on
    // the endpoint: this scope exists and the app asks for it, so the reader can close this alone.
    const warehouses = 'rest:sql.warehouses' as SignalId;
    const staleConsent: ControlResolver = {
      controls: ['X-01-01'],
      requires: [warehouses],
      resolve: () => ({ outcome: 'unmeasurable', evidence: [] }),
    };
    const signals = new Map<SignalId, SignalResult>([
      [
        warehouses,
        {
          id: warehouses,
          status: 'unmeasurable',
          coverage: { mode: 'complete' },
          unmeasurableReason: 'Provided OAuth token does not have required scopes: sql.warehouses:read',
          collectedAt: new Date(),
          durationMs: 1,
        },
      ],
    ]);

    const finding = resolveControl(spec({ measurability: 'rest-api' }), signals, staleConsent, undefined, {
      declaredScopes: ['sql.warehouses:read'],
    });

    expect(finding.remedy?.kind).toBe('re-authorise');
    expect(finding.unmeasured).toBe('unreadable');
  });

  it('labels nothing on an outcome that is not unmeasurable', () => {
    const decides: ControlResolver = {
      controls: ['X-01-01'],
      requires: [],
      resolve: () => ({ outcome: 'pass', evidence: [] }),
    };

    expect(resolveControl(spec(), NO_SIGNALS, decides).unmeasured).toBeUndefined();
  });

  it('takes a resolver at its word when it says the answer is not in the platform at all', () => {
    // The case the default gets wrong. A resolver that read its source successfully and found the
    // requirement unanswerable — an unset setting whose effective default is published nowhere, a
    // managed connector that registers nothing — is not a source the scan could not read, and
    // filing it as one sends the reader after a grant that would change nothing.
    const readItAndCannotTell: ControlResolver = {
      controls: ['X-01-01'],
      requires: [],
      resolve: () => ({
        outcome: 'unmeasurable',
        evidence: [],
        outcomeReason: 'The setting has never been set and its default is not published.',
        unmeasured: 'attestation',
      }),
    };

    const finding = resolveControl(spec({ measurability: 'rest-api' }), NO_SIGNALS, readItAndCannotTell);

    expect(finding.unmeasured).toBe('attestation');
    expect(finding.remedy?.kind).toBe('attest');
  });

  it('labels nothing on a control that does not apply, which is known rather than unknown', () => {
    const clusters = 'sql:compute.clusters' as SignalId;
    const finding = resolveControl(
      spec({
        measurability: 'attestation',
        preconditions: [
          {
            signal: clusters,
            // Explicit: the default is segment scope, which deliberately refuses to answer
            // rather than widen a per-segment question to the whole estate.
            scope: 'estate',
            operator: 'eq',
            value: 0,
            outcome: 'not-applicable',
            reason: 'This estate runs no classic clusters.',
          },
        ],
      }),
      new Map([[clusters, observed(clusters, 0)]]),
      undefined
    );

    // Asserted, not guarded: a conditional assertion here would pass silently if
    // applicability stopped resolving at all.
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.unmeasured).toBeUndefined();
  });
});

describe('what to do about an unknown', () => {
  it('says what to do rather than restating why, so the detail pane does not print itself twice', () => {
    // The regression this guards. The advice used to be a copy of `outcomeReason`, and the detail
    // pane renders both — so a reader saw the same sixty-word paragraph twice, a screen apart, and
    // the sentence they could act on was the one that looked like a duplicate.
    for (const control of [
      spec({ measurability: 'attestation' }),
      spec({ measurability: 'rest-api', collector: 'rest:workspace:clusters.list' }),
    ]) {
      const finding = resolveControl(control, NO_SIGNALS, undefined);

      expect(finding.remedy?.kind, control.collector).toBe('attest');
      expect(finding.remedy?.says).not.toBe(finding.outcomeReason);
    }
  });

  it('keeps the advice short, because it is the same words on most of the framework', () => {
    // In an estate that refuses nothing, every unmeasured requirement gets this — 105 of 184 on the
    // workspace this was built against, and only two distinct sentences between them. A paragraph
    // repeated that often is furniture: the reader meets it twice and stops reading the box, which
    // is where the one line that differs between the two kinds lives. Thirty words is the ceiling
    // for something that cannot vary, and what an answer *is* belongs on the page the link goes to.
    for (const control of [
      spec({ measurability: 'attestation' }),
      spec({ measurability: 'rest-api', collector: 'rest:workspace:clusters.list' }),
    ]) {
      const says = resolveControl(control, NO_SIGNALS, undefined).remedy?.says ?? '';
      expect(says.split(/\s+/u).length, says).toBeLessThanOrEqual(30);
    }
  });

  it('tells a reader chasing an ungrantable scope that there is nothing to chase', () => {
    const finding = resolveControl(
      spec({ measurability: 'rest-api', collector: 'rest:workspace:clusters.list' }),
      NO_SIGNALS,
      undefined
    );

    expect(finding.unmeasured).toBe('unreachable');
    // In the reason now, not in the advice. The advice carried a second sentence saying there was
    // nothing worth raising with Databricks, which read as a contradiction of the reason beside it —
    // that names a capability Databricks does not give apps, so a reader hears "no point raising it
    // with the people whose limit this is" as an argument with itself. The reason says the scope is
    // not offered to an app, which calls off the hunt for a grant without the quarrel.
    expect(finding.outcomeReason).toContain('does not offer an app');
    expect(finding.remedy?.kind).toBe('attest');
  });

  it('offers no such advice on our own unbuilt check, because the reader cannot answer around it', () => {
    const finding = resolveControl(
      spec({ measurability: 'system-table', evaluatorStatus: 'planned' }),
      NO_SIGNALS,
      undefined
    );

    expect(finding.unmeasured).toBe('unbuilt');
    expect(finding.remedy).toBeUndefined();
  });

  it('offers nothing where a resolver read good evidence and found it ambiguous', () => {
    // No access remedy exists for this, and inventing one would send a reader to grant something
    // when the app is only saying it could not tell.
    expect(resolveControl(spec(), NO_SIGNALS, cannotDecide()).remedy).toBeUndefined();
  });
});

describe('the reason and the advice, which render on the same pane', () => {
  /**
   * Overlapping runs of words between two sentences.
   *
   * Five words, because four catches ordinary English — "so it is not" is a phrase two unrelated
   * sentences share by accident — and six lets a real restatement through on a synonym. Stop words
   * are not stripped: a five-word run of stop words is itself a sign the same clause was written
   * twice, and stripping them turns a paraphrase check into a keyword check that fires on any two
   * sentences about the same subject.
   */
  function sharedRuns(reason: string, advice: string, run = 5): readonly string[] {
    const shingles = (text: string) => {
      const words = text
        .toLowerCase()
        // Signal identifiers first, and dropped rather than kept. Both sides name the signal they
        // are about — "the evidence (rest:workspace:preview.workspace-conf) was not collected" and
        // "the rest:workspace:preview.workspace-conf signal reported no reason" — and that is one
        // fact referred to twice by its name, not one thought written twice. Left in, punctuation
        // stripping turns each into five words and every such pair reads as a restatement. The
        // pattern covers both three-part ids (`rest:workspace:…`) and two-part ones (`sql:…`),
        // including ids that contain `{placeholder}` template fragments in the path segment.
        .replace(/\b[a-z]+:(?:[a-z-]+:)?[\w.{}-]+/gu, ' ')
        .replace(/[^a-z0-9\s]/gu, ' ')
        .split(/\s+/u)
        .filter(Boolean);
      return new Set(words.slice(0, Math.max(0, words.length - run + 1)).map((_, i) => words.slice(i, i + run).join(' ')));
    };

    const inAdvice = shingles(advice);
    return [...shingles(reason)].filter((phrase) => inAdvice.has(phrase));
  }

  it('finds no phrase in one that is already in the other, across every requirement', () => {
    // Three separate authors of this text got it wrong in three files — `whyUnresolved`, the
    // endpoints resolver, and `attestRemedy` itself — and each time the symptom was the same: the
    // detail pane printing one thought twice, a few inches apart, with the actionable copy in the
    // position that looked like the duplicate. The reader learns to skip the second box.
    //
    // Checked over the whole catalogue rather than a fixture, because the reason is written per
    // resolver and a new one is exactly where the fourth instance comes from.
    const restated: string[] = [];

    for (const control of CATALOGUE.controls) {
      const finding = resolveControl(control, NO_SIGNALS, REGISTRY.get(control.id));
      if (finding.outcomeReason == null || finding.remedy == null) continue;

      const shared = sharedRuns(finding.outcomeReason, finding.remedy.says);
      if (shared.length > 0) restated.push(`${control.id}: "${shared[0] ?? ''}"`);
    }

    expect(restated).toEqual([]);
  });

  it('would catch a restatement, so the pass above means something', () => {
    // The check is a heuristic, and a heuristic asserted only against passing data is indistinguishable
    // from `expect([]).toEqual([])`.
    const sentence = 'This practice leaves no trace on the platform, so nothing can settle it.';
    expect(sharedRuns(sentence, `Answer it yourself. ${sentence}`).length).toBeGreaterThan(0);
    expect(sharedRuns(sentence, 'Record an answer and it will lapse on its review date.')).toEqual([]);
  });
});
