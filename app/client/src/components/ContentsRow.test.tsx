// The contents row's marking rule, which is a decision rather than a style.
//
// The rule is: mark by exception. A tick where the answer still counts, a badge where it needs
// attention, and nothing at all where the question has never been answered. It is pinned here
// because both halves are the sort of thing a later reader improves away — the missing marker looks
// like an omission, and "every row should say what it is" is a reasonable-sounding instinct that
// costs a hundred badges in a contents column and, if the marker is hidden instead of drawn, a
// document that scrolls on a shell locked to the window. See the note in ContentsRow.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentsRow } from './ContentsRow';
import type { Attestation, AttestableRequirement, AttestationState } from '../api/types';

const question = (state?: AttestationState): AttestableRequirement => ({
  controlId: 'REL-01-02',
  pillarId: 'reliability',
  principleId: 'rel-01',
  title: 'Recover from failures without losing data',
  severity: 'high',
  askedBecause: 'no-telemetry',
  question: 'Can the platform recover without losing data?',
  cadenceDays: 365,
  ...(state == null
    ? {}
    : {
        attestation: {
          id: 'att-1',
          controlId: 'REL-01-02',
          answer: 'met',
          statement: 'A statement long enough to satisfy the rule.',
          owner: 'platform-engineering',
          attestedBy: 'ada@example.com',
          attestedAt: '2026-01-01T00:00:00.000Z',
          reviewBy: '2026-07-01T00:00:00.000Z',
          state,
        } satisfies Attestation,
      }),
});

const html = (state?: AttestationState, deferred = false): string =>
  renderToStaticMarkup(
    <ContentsRow question={question(state)} selected={false} deferred={deferred} onSelect={() => undefined} />
  );

describe('a row in the contents of a pass', () => {
  it('marks an answer that still counts with a tick rather than a badge', () => {
    const markup = html('current');

    expect(markup).toContain('Answered');
    expect(markup).toContain('<svg');
  });

  it('says nothing at all about a question that has never been answered', () => {
    const markup = html();

    // Neither drawn nor announced. The word appearing here at all would mean either a badge on every
    // row of a first pass, or a hidden span that escapes the shell's clip.
    expect(markup).not.toContain('Unanswered');
    expect(markup).not.toContain('sr-only');
    expect(markup).toContain('Recover from failures without losing data');
  });

  // Which treatment the row chooses, not what the badge says — the wording is StateBadge's, and
  // asserting it here would make renaming a state a two-file change for no gain.
  it('badges the two states that need attention', () => {
    for (const state of ['due', 'expired'] as const) {
      expect(html(state), state).toContain('wa-badge');
    }
    expect(html('current')).not.toContain('wa-badge');
    expect(html()).not.toContain('wa-badge');
  });

  it('says when a question was left for a colleague, whatever its state', () => {
    expect(html(undefined, true)).toContain('Left for later');
    expect(html('expired', true)).toContain('Left for later');
  });
});
