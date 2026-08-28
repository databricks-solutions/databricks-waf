// The validation trail, rendered, because the defects it exists to prevent are all defects of markup.
//
// Every one of these tests is a version of this pane that would read as progress. A pane that showed
// only the attempt that held; one that coloured a question nobody has answered; one that offered a
// button the server refuses; one that let a person mark an attempt passed. The pane is only worth
// having if none of those are reachable, so they are asserted rather than described.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { ValidationTrailView, type ValidationTrailViewProps } from './ValidationTrail';
import { RESULT_LABEL } from '../pages/validate-language';
import type { ValidationAttempt } from '../api/types';

const NOW = new Date('2026-04-10T12:00:00.000Z');

const OUTSTANDING: ValidationAttempt = {
  id: 'val-2',
  planId: 'plan-1',
  actionId: 'act-1',
  checks: [{ controlId: 'SEC-01', method: 'measured', title: 'Secrets are not in cluster configuration' }],
  claimedAt: '2026-04-09T09:00:00.000Z',
  requestedBy: 'ana@example.com',
  requestedAt: '2026-04-09T09:05:00.000Z',
  observeFrom: '2026-04-12T09:05:00.000Z',
  observeDays: 3,
};

const FAILED: ValidationAttempt = {
  id: 'val-1',
  planId: 'plan-1',
  actionId: 'act-1',
  checks: [{ controlId: 'SEC-01', method: 'measured', title: 'Secrets are not in cluster configuration' }],
  claimedAt: '2026-04-01T09:00:00.000Z',
  requestedBy: 'ana@example.com',
  requestedAt: '2026-04-01T09:05:00.000Z',
  observeFrom: '2026-04-01T09:05:00.000Z',
  observeDays: 0,
  answer: {
    result: 'failed',
    scanId: 'scan-77',
    at: '2026-04-02T02:00:00.000Z',
    unmet: ['SEC-01'],
    unreadable: [],
  },
};

const view = (over: Partial<ValidationTrailViewProps> = {}): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ValidationTrailView
        attempts={[OUTSTANDING, FAILED]}
        mayRequest={false}
        maxObserveDays={90}
        saving={false}
        now={NOW}
        onRequest={() => Promise.resolve(true)}
        {...over}
      />
    </MemoryRouter>
  );

describe('the attempts against a claim', () => {
  it('shows every attempt, including the ones that failed', () => {
    const markup = view();

    expect(markup).toContain('2 attempted');
    expect(markup).toContain('Still failing');
    expect(markup).toContain('Waiting on a run');
  });

  it('reads a question nobody has answered as waiting rather than as a result', () => {
    const markup = view({ attempts: [OUTSTANDING] });

    expect(markup).toContain('Waiting on a run');
    // Through the constant rather than the words, so renaming a result cannot quietly leave this
    // asserting the absence of a label the app no longer uses. The first version asserted "Held up",
    // which the deployed app then stopped saying.
    expect(markup).not.toContain(RESULT_LABEL.passed);
    expect(markup).not.toContain(RESULT_LABEL.failed);
    expect(markup).not.toContain(RESULT_LABEL.incomplete);
  });

  it('says which run answered an attempt and links to it', () => {
    const markup = view({ attempts: [FAILED] });

    expect(markup).toContain('run scan-77');
    expect(markup).toContain('/history/scan-77');
  });

  it('names the requirements a run said were still unmet', () => {
    const markup = view({ attempts: [FAILED] });

    expect(markup).toContain('Still unmet');
    expect(markup).toContain('/findings?control=SEC-01');
  });

  it('says the date the work was claimed done, which every other date is measured against', () => {
    const markup = view({ attempts: [FAILED] });

    expect(markup).toContain('Claimed done on');
    expect(markup).toContain('Asked by ana@example.com');
  });

  it('says how long the window was, where one was asked for', () => {
    expect(view({ attempts: [OUTSTANDING] })).toContain('3 days were allowed');
    // Not "0 days": no window is the ordinary case, and a line saying so on every attempt is width
    // spent on the absence of a decision.
    expect(view({ attempts: [FAILED] })).not.toContain('days were allowed');
  });

  it('keeps an attempt the app could not finish apart from one that failed', () => {
    const incomplete: ValidationAttempt = {
      ...FAILED,
      checks: [{ controlId: 'GOV-04', method: 'attested', title: 'Reviews happen quarterly' }],
      answer: {
        result: 'incomplete',
        scanId: 'scan-78',
        at: '2026-04-02T02:00:00.000Z',
        unmet: [],
        unreadable: ['GOV-04'],
        why: 'GOV-04 is answered by somebody’s word, and the answer on record predates this work.',
      },
    };
    const markup = view({ attempts: [incomplete] });

    expect(markup).toContain('Could not tell');
    expect(markup).not.toContain('Still failing');
    expect(markup).toContain('No answer for');
    expect(markup).toContain('predates this work');
    // The freshness rule, once, where a reader is about to ask why a met requirement did not verify.
    expect(markup).toContain('somebody’s word');
  });

  it('never offers anything that would mark an attempt passed', () => {
    const markup = view({ attempts: [OUTSTANDING], onWithdraw: () => Promise.resolve(true) });

    expect(markup).not.toContain('Mark it verified');
    expect(markup).not.toContain('Passed');
    expect(markup).toContain('Withdraw the claim');
  });

  it('offers no withdrawal on an attempt a run has already answered', () => {
    const markup = view({ attempts: [FAILED], onWithdraw: () => Promise.resolve(true) });

    expect(markup).not.toContain('Withdraw the claim');
  });
});

describe('asking for one', () => {
  it('offers the form only when the server would accept a request', () => {
    const asked = view({ mayRequest: true });

    expect(asked).toContain('Ask a run to check it');
    expect(view({ mayRequest: false })).not.toContain('Ask a run to check it');
  });

  it('says why it cannot be asked for, in the server’s words', () => {
    const markup = view({
      mayRequest: false,
      whyNot: 'A validation of this action is already outstanding, waiting for a run.',
    });

    expect(markup).toContain('already outstanding');
  });

  it('says a run answers it, not a person', () => {
    expect(view({ mayRequest: true })).toContain('The run answers this, not a person.');
  });

  it('shows a refusal even where the form that sent it is no longer offered', () => {
    // A withdrawal is sent from inside an attempt, and by the time it is refused the section has been
    // re-read. Without this the server's sentence would have nowhere to appear.
    const markup = view({ mayRequest: false, writeError: 'A run answered this between the read and the click.' });

    expect(markup).toContain('between the read and the click');
  });
});

describe('an install that is not keeping them', () => {
  it('says so where somebody is about to ask for one', () => {
    const markup = view({
      mayRequest: true,
      durabilityNote: 'Validations are being kept in memory, so a restart loses every attempt.',
    });

    expect(markup).toContain('kept in memory');
  });
});

describe('an action nobody has claimed done', () => {
  it('renders nothing at all rather than a paragraph explaining itself', () => {
    expect(view({ attempts: [], mayRequest: false })).toBe('');
  });

  it('still says why the attempts could not be read', () => {
    expect(view({ attempts: [], mayRequest: false, error: 'The attempts could not be read.' })).toContain(
      'could not be read'
    );
  });
});
