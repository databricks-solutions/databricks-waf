// The three ways to read an unset setting, and the one control that needs two signals.
//
// The unset case is what this suite is really about. Every one of these controls will meet
// a workspace that has never opened the settings page, and the difference between reporting
// that as a failure, a pass, or an unmeasured control is the difference between a tool
// worth acting on and one worth ignoring.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import { MAX_TOKEN_LIFETIME_KEY, REQUESTED_KEYS } from '../../collect/rest/settings-keys.js';
import type { TokenInventory } from '../../collect/rest/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();

const SETTINGS = 'rest:workspace:preview.workspace-conf' as SignalId;
const TOKENS = 'rest:workspace:token.list' as SignalId;
const SERVING = 'rest:workspace:serving-endpoints' as SignalId;

/** Settings as the collector reports them: every requested key present, unset ones null. */
function settingsSignal(set: Readonly<Record<string, string>>): SignalResult {
  const values = new Map<string, string | null>(REQUESTED_KEYS.map((key) => [key, set[key] ?? null]));
  return observed(SETTINGS, { values, unanswered: [] }, 0);
}

function resolve(controlId: string, signals: Iterable<[SignalId, SignalResult]>) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  return resolveControl(spec, new Map(signals), registry.get(controlId));
}

const day = 86_400_000;

function tokensSignal(tokens: TokenInventory['tokens']): SignalResult {
  return observed(TOKENS, { tokens, truncated: false }, 0);
}

describe('a setting nobody has ever set', () => {
  it('fails an enforcement flag, because nothing enforces itself', () => {
    const finding = resolve('SCP-03-10', [[SETTINGS, settingsSignal({})]]);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('never been set');
    // The reason has to carry the argument, not just the verdict: a workspace admin who
    // disagrees with reading absence as non-enforcement can only argue with a stated reason.
    expect(finding.outcomeReason ?? '').toContain('inert');
  });

  it('declines a flag whose default it cannot know', () => {
    // IMDSv2 is enforced by default on newer AWS workspaces without the setting being
    // present, so absence is genuinely ambiguous. Guessing either way would be a
    // fabrication; this is the case the third answer exists for.
    const finding = resolve('SCP-04-08', [[SETTINGS, settingsSignal({})]]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason ?? '').toContain('cannot be determined');
    // The call succeeded and reported the workspace's real state: never touched. The effective
    // default it falls back to is published nowhere, so this ends at a person rather than at a
    // grant, and the finding says so instead of joining the pile of unreadable sources.
    expect(finding.unmeasured).toBe('attestation');
    expect(finding.remedy?.kind).toBe('attest');
  });

  it('separates a key the workspace does not have from one it has not set', () => {
    const values = new Map<string, string | null>();
    const finding = resolve('SCP-02-04', [
      [SETTINGS, observed(SETTINGS, { values, unanswered: ['enableResultsDownloading'] }, 0)],
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason ?? '').toContain('does not recognise');
  });
});

describe('a setting somebody set', () => {
  it('passes when it matches and says the failure was deliberate when it does not', () => {
    expect(resolve('SCP-03-10', [[SETTINGS, settingsSignal({ enableIpAccessLists: 'true' })]]).outcome).toBe('pass');

    const failing = resolve('SCP-03-10', [[SETTINGS, settingsSignal({ enableIpAccessLists: 'false' })]]);
    expect(failing.outcome).toBe('fail');
    expect(failing.evidence[0]?.observed).toContain('disabled');
    // Worth distinguishing from the unset case: someone chose this, so the conversation is
    // about revisiting a decision rather than about finishing a setup.
    expect(failing.outcomeReason ?? '').toContain('deliberate setting');
  });

  it('reads a restriction the right way round', () => {
    // The secure value here is false, not true. A table-driven resolver that assumed
    // true-is-good would invert five controls at once, which is why this is asserted.
    expect(resolve('SCP-02-05', [[SETTINGS, settingsSignal({ enableExportNotebook: 'false' })]]).outcome).toBe('pass');
    expect(resolve('SCP-02-05', [[SETTINGS, settingsSignal({ enableExportNotebook: 'true' })]]).outcome).toBe('fail');
  });
});

describe('the token lifetime maximum', () => {
  it('treats a negative maximum as unlimited rather than as very short', () => {
    // -1 is the API's "never expires". Compared numerically it is less than any threshold,
    // so the least restrictive setting possible would score as the best one.
    const finding = resolve('SCP-01-04', [[SETTINGS, settingsSignal({ [MAX_TOKEN_LIFETIME_KEY]: '-1' })]]);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('unlimited');
  });

  it('gives partial credit for a bounded maximum that is too long', () => {
    const finding = resolve('SCP-01-04', [[SETTINGS, settingsSignal({ [MAX_TOKEN_LIFETIME_KEY]: '365' })]]);

    // A bounded lifetime and an unbounded one are not the same risk, and rounding the
    // difference away teaches people the score is not worth reading.
    expect(finding.outcome).toBe('partial');
    expect(resolve('SCP-01-04', [[SETTINGS, settingsSignal({ [MAX_TOKEN_LIFETIME_KEY]: '30' })]]).outcome).toBe('pass');
  });
});

describe('the tokens themselves', () => {
  it('is not applicable when there are none, rather than a pass', () => {
    const finding = resolve('SCP-01-03', [[TOKENS, tokensSignal([])]]);
    expect(finding.outcome).toBe('not-applicable');
  });

  it('finds the perpetual ones and names who holds them', () => {
    const finding = resolve('SCP-01-03', [
      [
        TOKENS,
        tokensSignal([
          { id: 'a', createdBy: 'ada@example.com', comment: undefined, createdAt: new Date(), expiresAt: undefined },
          { id: 'b', createdBy: 'grace@example.com', comment: undefined, createdAt: new Date(), expiresAt: new Date(Date.now() + 40 * day) },
        ]),
      ],
    ]);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('1 of 2');
    expect(finding.evidence[1]?.observed).toContain('ada@example.com');
  });

  it('declines to compare tokens against a maximum that does not exist', () => {
    // Reporting "no token exceeds the policy" when there is no policy would be technically
    // true and read as a pass on token hygiene.
    const finding = resolve('SCP-01-05', [
      [SETTINGS, settingsSignal({})],
      [TOKENS, tokensSignal([{ id: 'a', createdBy: 'ada', comment: undefined, createdAt: new Date(), expiresAt: new Date() }])],
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason ?? '').toContain('no policy');
  });

  it('finds tokens issued before the maximum was set', () => {
    const created = new Date('2024-01-01T00:00:00Z');
    const finding = resolve('SCP-01-05', [
      [SETTINGS, settingsSignal({ [MAX_TOKEN_LIFETIME_KEY]: '90' })],
      [
        TOKENS,
        tokensSignal([
          { id: 'old', createdBy: 'ada', comment: undefined, createdAt: created, expiresAt: new Date(created.getTime() + 400 * day) },
          { id: 'new', createdBy: 'grace', comment: undefined, createdAt: created, expiresAt: new Date(created.getTime() + 30 * day) },
        ]),
      ],
    ]);

    expect(finding.outcome).toBe('fail');
    // The point of the control: the policy is in force for new tokens and not yet true of
    // the estate, which is a different job from setting the policy.
    expect(finding.outcomeReason ?? '').toContain('predate it');
  });
});

describe('serving endpoints', () => {
  it('does not fault an estate that serves nothing', () => {
    const finding = resolve('SCP-05-10', [[SERVING, observed(SERVING, { endpoints: [], truncated: false }, 0)]]);
    expect(finding.outcome).toBe('not-applicable');
  });

  it('reads the absence of external-model routing as partial, not failure', () => {
    // Whether third-party models are being called directly from notebooks is not visible
    // from the endpoint list, so a failure here would be asserting something unmeasured.
    const finding = resolve('SCP-05-10', [
      [SERVING, observed(SERVING, { endpoints: [{ name: 'a', servedExternalModel: false, state: 'READY' }], truncated: false }, 0)],
    ]);
    expect(finding.outcome).toBe('partial');
  });
});
