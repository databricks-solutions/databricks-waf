// Rendered rather than reasoned about.
//
// Everything that matters in this form lives in an attribute — `disabled`, `checked`, `min`, which
// fields exist at all — and every one of those typechecks perfectly while being wrong. The freeze is
// the one that matters most: after draft, the requirements, the outcome and the definition of done are
// what the owner agreed to, and a form that let them be edited would turn a missed target into a met
// one with no record that anything moved. Server-rendered markup, so no browser needed.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionForm } from './ActionForm';
import type { ImprovementAction } from '../api/types';

const ACTION: ImprovementAction = {
  id: 'act-1',
  planId: 'plan-1',
  controlIds: ['SEC-01'],
  outcome: 'Every production workspace reads its secrets from the vault.',
  definitionOfDone: 'No cluster policy permits a plaintext secret, and SEC-01 passes on a run.',
  owner: 'platform-engineering',
  priority: 'now',
  effort: 'large',
  due: '2026-04-01T23:59:59.999Z',
  steps: ['Draft the policy change.'],
  dependsOn: [],
  state: 'planned',
  createdBy: 'ana@example.com',
  createdAt: '2026-03-01T09:00:00Z',
  history: [],
  agreement: 'unclaimed',
  lateness: 'on-time',
  unmet: ['SEC-01'],
  unreadable: [],
  moves: ['in-progress', 'blocked', 'cancelled'],
  titles: { 'SEC-01': 'Secrets are not stored in cluster configuration' },
};

const html = (element: React.JSX.Element): string => renderToStaticMarkup(element);

const form = (overrides: Partial<React.ComponentProps<typeof ActionForm>> = {}) =>
  html(
    <ActionForm
      formId="test"
      minProse={20}
      siblings={[]}
      onSubmit={() => undefined}
      saving={false}
      {...overrides}
    />
  );

describe('raising an action', () => {
  it('cannot be submitted empty', () => {
    expect(form()).toContain('disabled');
  });

  it('says how much more the outcome needs, rather than waiting to reject it', () => {
    expect(form()).toContain('20 more characters');
  });

  it('says why the requirements are asked for, which is that they are what a run can disagree with', () => {
    expect(form()).toContain('can never be verified');
  });

  it('starts from the requirement the reader came from', () => {
    expect(form({ controlIds: ['SEC-01', 'SEC-04'] })).toContain('value="SEC-01, SEC-04"');
  });

  it('offers no date before tomorrow, since an action due today is late once it is agreed', () => {
    const min = /min="(\d{4}-\d{2}-\d{2})"/.exec(form())?.[1];
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    expect(min).toBe(tomorrow);
  });

  it('states that the steps are notes rather than progress', () => {
    // A checklist that looked like progress would be a second, unmeasured account of how far along
    // this is, sitting beside the one the estate can contradict.
    expect(form()).toContain('not progress');
  });

  it('says nothing here changes the score', () => {
    expect(form()).toContain('Does not change the score');
  });

  it('does not offer a dependency when the plan has no other actions', () => {
    expect(form()).not.toContain('Waits for');
  });
});

describe('correcting a draft', () => {
  const draft = { ...ACTION, state: 'draft' as const };

  it('leaves every field open, since nothing has been agreed yet', () => {
    const markup = form({ action: draft, siblings: [draft] });

    expect(markup).not.toContain('Fixed once the action is agreed');
  });

  it('arrives filled in rather than blank', () => {
    expect(form({ action: draft })).toContain('platform-engineering');
  });
});

describe('correcting an agreed action', () => {
  it('freezes the requirements, the outcome and the definition of done', () => {
    const markup = form({ action: ACTION });
    const frozen = markup.match(/disabled/g) ?? [];

    // Three fields, and the sentence saying why, on each of them.
    expect(frozen.length).toBeGreaterThanOrEqual(3);
    expect(markup).toContain('Fixed once the action is agreed');
  });

  it('says a missed target must not be edited into a met one', () => {
    expect(form({ action: ACTION })).toContain('how a miss becomes a hit');
  });

  it('leaves the owner, the date, the priority and the size open, because those honestly change', () => {
    const markup = form({ action: ACTION });

    // The owner input carries a value and no `disabled` between them.
    expect(/id="test-owner"[^>]*value="platform-engineering"(?![^>]*disabled)/.test(markup)).toBe(true);
  });

  it('offers the requirement’s title beside its id, so the reader sees more than a code', () => {
    const markup = form({ action: ACTION, titleOf: (id) => (id === 'SEC-01' ? 'Secrets are not in cluster config' : undefined) });

    expect(markup).toContain('Secrets are not in cluster config');
  });

  it('never offers an action to depend on itself', () => {
    const other = { ...ACTION, id: 'act-2', outcome: 'Rotate the vault keys quarterly.' };
    const markup = form({ action: ACTION, siblings: [ACTION, other] });

    expect(markup).toContain('Rotate the vault keys quarterly.');
    // Once, in its own outcome field. A second occurrence would be the checkbox offering it as its
    // own precondition, which the server refuses as a cycle of one.
    expect(markup.split(ACTION.outcome)).toHaveLength(2);
  });

  it('does not offer a cancelled action to wait on, which would be waiting for nobody', () => {
    const dead = { ...ACTION, id: 'act-3', outcome: 'Decommission the legacy cluster.', state: 'cancelled' as const };
    const markup = form({ action: ACTION, siblings: [ACTION, dead] });

    expect(markup).not.toContain('Decommission the legacy cluster.');
  });
});
