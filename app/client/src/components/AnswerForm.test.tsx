// Rendered rather than reasoned about.
//
// The properties under test are the ones that decide whether this form collects an answer or
// collects agreement, and all of them live in attributes — `checked`, `disabled`, `value` — which
// typecheck perfectly while being wrong. Server-rendered markup, so no browser is needed.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnswerForm, answerBlockingReasons, answerFormKey } from './AnswerForm';
import type { AttestableRequirement } from '../api/types';

const REQUIREMENT: AttestableRequirement = {
  controlId: 'OE-01-01',
  pillarId: 'operational-excellence',
  principleId: 'oe-01',
  title: 'Rehearse recovery',
  severity: 'high',
  askedBecause: 'no-telemetry',
  question: 'Is recovery rehearsed at least twice a year?',
  cadenceDays: 180,
};

const ANSWERED: AttestableRequirement = {
  ...REQUIREMENT,
  attestation: {
    id: 'att-1',
    controlId: 'OE-01-01',
    answer: 'partially-met',
    statement: 'Rehearsed for the two tier-one workloads each quarter, not yet for the rest.',
    owner: 'platform-engineering',
    attestedBy: 'ada@example.com',
    attestedAt: '2026-01-01T00:00:00.000Z',
    reviewBy: '2026-07-01T00:00:00.000Z',
    state: 'due',
  },
};

const html = (element: React.JSX.Element): string => renderToStaticMarkup(element);

const form = (requirement: AttestableRequirement) =>
  html(<AnswerForm requirement={requirement} onSubmit={() => undefined} saving={false} saved={false} />);

describe('a requirement nobody has answered', () => {
  it('preselects no answer', () => {
    // A form that arrives with "In place" ticked collects agreement rather than an answer, and the
    // reader who submits it without reading has attested to something they never considered.
    expect(form(REQUIREMENT)).not.toContain('checked');
  });

  it('cannot be submitted', () => {
    expect(form(REQUIREMENT)).toContain('disabled');
  });

  it('says how much more the statement needs, rather than waiting to reject it', () => {
    expect(form(REQUIREMENT)).toContain('20 more characters');
  });

  it('states every missing requirement beside the disabled action', () => {
    const markup = form(REQUIREMENT);

    expect(markup).toContain('To enable Record answer:');
    expect(markup).toContain('choose an answer');
    expect(markup).toContain('write 20 more characters in “What this is based on”');
    expect(markup).toContain('name who is accountable');
    expect(markup).toContain('aria-describedby="submit-help-OE-01-01"');
  });

  it('offers to record rather than to confirm', () => {
    expect(form(REQUIREMENT)).toContain('Record answer');
  });

  it('states the effect of each answer on the score beside the choice', () => {
    const markup = form(REQUIREMENT);

    expect(markup).toContain('Counts as half met');
    expect(markup).toContain('Leaves the score entirely');
  });

  it('says how often the answer will need confirming', () => {
    expect(form(REQUIREMENT)).toContain('Confirm every 6 months');
  });
});

describe('a requirement being confirmed again', () => {
  it('starts from the previous answer rather than from nothing', () => {
    // Re-confirmation is the common case after the first cycle. Making the reader retype a
    // statement they already wrote is how re-attestation becomes "as before".
    const markup = form(ANSWERED);

    expect(markup).toContain('checked');
    expect(markup).toContain('not yet for the rest');
    expect(markup).toContain('platform-engineering');
  });

  it('is submittable, since the previous answer already satisfies the rules', () => {
    expect(form(ANSWERED)).not.toContain('disabled');
  });

  it('offers to confirm rather than to record', () => {
    expect(form(ANSWERED)).toContain('Confirm answer');
  });

  it('does not show disabled-action guidance when every required field is complete', () => {
    expect(form(ANSWERED)).not.toContain('To enable Confirm answer:');
  });
});

describe('the disabled action explanation', () => {
  it('updates the exact remaining statement length without hiding the other missing field', () => {
    expect(answerBlockingReasons('met', 'Twelve chars', '')).toEqual([
      'write 8 more characters in “What this is based on”',
      'name who is accountable',
    ]);
  });

  it('has nothing to explain once the form is ready', () => {
    expect(answerBlockingReasons('not-met', 'This statement is long enough.', 'platform-engineering')).toEqual([]);
  });
});

describe('the key that resets the fields', () => {
  it('changes with the requirement', () => {
    expect(answerFormKey(REQUIREMENT)).not.toBe(answerFormKey({ ...REQUIREMENT, controlId: 'OE-01-02' }));
  });

  it('changes when an answer is recorded against the same requirement', () => {
    // Without this the form would keep the fields the typist just submitted, and the next reader
    // would see a draft where the recorded answer should be.
    expect(answerFormKey(ANSWERED)).not.toBe(answerFormKey(REQUIREMENT));
  });
});

describe('the server rejecting an answer', () => {
  it('shows the reason against the form and announces it', () => {
    const markup = html(
      <AnswerForm
        requirement={REQUIREMENT}
        onSubmit={() => undefined}
        saving={false}
        saved={false}
        error="An owner is required."
      />
    );

    expect(markup).toContain('An owner is required.');
    expect(markup).toContain('role="alert"');
  });
});
