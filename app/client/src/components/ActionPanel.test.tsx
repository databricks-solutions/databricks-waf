// The pane, rendered, because its whole job is to show two readings at once and never merge them.
//
// The state is what the owner says; the agreement is what the last run says. Where they disagree the
// pane has to say both, and the temptation in every tracker ever written is to show one badge and let
// the reader assume the other. The tests below hold it to the version that cannot be misread — and to
// never offering `verified` as something a person may press, which is the one move that would let
// somebody close a row the estate has not agreed with.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { ActionPanel } from './ActionPanel';
import type { ImprovementAction } from '../api/types';

const ACTION: ImprovementAction = {
  id: 'act-10000000',
  planId: 'plan-1',
  controlIds: ['SEC-01'],
  outcome: 'Every production workspace reads its secrets from the vault.',
  definitionOfDone: 'No cluster policy permits a plaintext secret, and SEC-01 passes on a run.',
  owner: 'platform-engineering',
  priority: 'now',
  effort: 'large',
  due: '2026-04-01T23:59:59.999Z',
  steps: ['Draft the policy change.', 'Roll it out to staging.'],
  dependsOn: [],
  state: 'ready-for-validation',
  createdBy: 'ana@example.com',
  createdAt: '2026-03-01T09:00:00Z',
  history: [
    { from: 'draft', to: 'planned', at: '2026-03-02T09:00:00Z', by: 'person', who: 'ana@example.com' },
    { from: 'planned', to: 'in-progress', at: '2026-03-03T09:00:00Z', by: 'person', who: 'raj@example.com' },
  ],
  agreement: 'awaiting',
  lateness: 'on-time',
  unmet: [],
  unreadable: [],
  moves: ['in-progress', 'blocked', 'cancelled'],
  titles: { 'SEC-01': 'Secrets are not stored in cluster configuration' },
};

const panel = (action: ImprovementAction, over: { frozen?: boolean } = {}): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ActionPanel
        action={action}
        siblings={[action]}
        minProse={20}
        frozen={over.frozen ?? false}
        onChanged={() => undefined}
      />
    </MemoryRouter>
  );

describe('an action somebody says is done', () => {
  it('leads with owner, exact requirement, verification and a status action', () => {
    const markup = panel(ACTION);

    expect(markup).toContain('Improvement action');
    expect(markup).toContain('platform-engineering');
    expect(markup).toContain('No cluster policy permits a plaintext secret');
    expect(markup).toContain('href="/investigate?control=SEC-01"');
    expect(markup).toContain('href="#action-moves-act-10000000"');
    expect(markup).toContain('Update status');
    expect(markup).toContain('This action closes SEC-01');
    expect(markup).toContain('Current standing');
  });

  it('states the outcome once before its standing and evidence', () => {
    const markup = panel(ACTION);
    expect(markup.match(/Every production workspace reads its secrets from the vault\./g)).toHaveLength(1);
  });

  it('keeps the internal action id out of the customer reading order', () => {
    expect(panel(ACTION)).not.toContain('>act-1000<');
  });

  it('shows what the owner says and what the estate says, separately', () => {
    const markup = panel(ACTION);

    expect(markup).toContain('Waiting on a run');
    expect(markup).toContain('Awaiting a run');
    expect(markup).toContain('until one does');
  });

  it('does not offer verified as a move a person can make', () => {
    // The one claim in this app that only a measurement may make. A button here would be the app
    // inviting somebody to close a row the estate has not agreed with.
    expect(panel(ACTION)).not.toContain('Verified by a run');
  });

  it('offers the moves the server gave it, and nothing else', () => {
    const markup = panel(ACTION);

    expect(markup).toContain('Start it');
    expect(markup).toContain('Blocked');
    expect(markup).toContain('Cancel it');
    expect(markup).not.toContain('Done, check it');
  });

  it('says a move does not change the score', () => {
    expect(panel(ACTION)).toContain('decided by');
  });

  it('labels the steps as notes rather than as progress', () => {
    expect(panel(ACTION)).toContain('Notes, not progress');
  });
});

describe('an action the estate contradicts', () => {
  const contradicted: ImprovementAction = { ...ACTION, agreement: 'contradicted', unmet: ['SEC-01'] };

  it('says the run still measures the requirement as unmet, in words', () => {
    const markup = panel(contradicted);

    expect(markup).toContain('Still failing');
    expect(markup).toContain('did not take');
  });

  it('names the requirement rather than counting it, so the reader can check', () => {
    expect(panel(contradicted)).toContain('Still unmet');
    expect(panel(contradicted)).toContain('SEC-01');
  });
});

describe('an action nothing could measure', () => {
  const unmeasured: ImprovementAction = { ...ACTION, agreement: 'unmeasured', unreadable: ['SEC-01'] };

  it('distinguishes a blind spot from a failure', () => {
    expect(panel(unmeasured)).toContain('not the same as failing');
  });
});

describe('an action in a closed plan', () => {
  it('offers no moves and says why', () => {
    const markup = panel(ACTION, { frozen: true });

    expect(markup).not.toContain('Start it');
    expect(markup).toContain('This plan is closed');
    expect(markup).toContain('open a new plan');
  });
});

describe('an action a run has verified', () => {
  const verified: ImprovementAction = { ...ACTION, state: 'verified', agreement: 'agreed', moves: [] };

  it('says a run agreed rather than that somebody closed it', () => {
    const markup = panel(verified);

    expect(markup).toContain('A run agreed with the owner');
    expect(markup).toContain('A run agreed with this.');
  });

  /*
   * Measured on the deployed app, not reasoned about: the state note, the estate reading and the
   * attempt's own result each said a run had measured every requirement as met, and all three landed in
   * one column a few centimetres apart. Each was written in a different module and tested in a
   * different file, which is how three correct sentences became one stutter.
   */
  it('says a run agreed once, not three times over', () => {
    const markup = panel(verified);
    const measured = markup.match(/measured every requirement/g) ?? [];

    expect(measured.length).toBeLessThanOrEqual(1);
  });
});

describe('the history', () => {
  it('reads newest first, because the last move is the one somebody remembers the reason for', () => {
    const markup = panel(ACTION);

    expect(markup.indexOf('raj@example.com')).toBeLessThan(markup.indexOf('ana@example.com'));
  });

  it('names a run as a run, so a scan id is never read as a colleague', () => {
    const verified: ImprovementAction = {
      ...ACTION,
      state: 'verified',
      agreement: 'agreed',
      moves: [],
      history: [
        ...ACTION.history,
        { from: 'ready-for-validation', to: 'verified', at: '2026-03-09T09:00:00Z', by: 'run', who: 'scan-4f2c' },
      ],
    };

    expect(panel(verified)).toContain('run scan-4f2c');
  });
});
