// The lost audit events, asserted on the HTML they emit.
//
// What is worth holding is what the list refuses to claim. An acknowledgement is a person saying they
// have looked, not a repair, so the button is not called anything that says resolved, the sentence says
// what it does not do, and a list that could not be read is not rendered as an empty one.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AuditGapList } from './AuditGapList';
import type { Diagnostics } from '../api/types';

type Gaps = NonNullable<Diagnostics['auditGaps']>;

const NOW = '2026-08-04T09:00:00.000Z';

const GAP: Gaps['gaps'][number] = {
  id: 'event-9',
  at: '2026-08-03T11:30:00.000Z',
  actor: 'dana@example.com',
  action: 'attestation.record',
  phrase: 'answer a requirement',
  outcome: 'performed',
  target: { kind: 'control', id: 'OE-02-04' },
  cause: 'AuditAppendError',
};

function gaps(over: Partial<Gaps> = {}): Gaps {
  return { gaps: [GAP], truncated: false, ...over };
}

function render(props: Partial<Parameters<typeof AuditGapList>[0]> = {}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AuditGapList gaps={gaps()} at={NOW} onAcknowledge={() => undefined} {...props} />
    </MemoryRouter>
  );
}

describe('AuditGapList', () => {
  it('says who did what, to what, and how the trail refused it', () => {
    const html = render();

    expect(html).toContain('dana@example.com — answer a requirement');
    expect(html).toContain('Requirement OE-02-04');
    expect(html).toContain('AuditAppendError');
    expect(html).toContain('went ahead');
  });

  it('says what acknowledging does not do, before offering it', () => {
    const html = render();

    expect(html).toContain('does not recover the event');
    expect(html).toContain('Acknowledge');
    // Not the word for a repair, which an acknowledgement is not.
    expect(html).not.toMatch(/Resolve|Fix|Dismiss/);
  });

  it('shows no button where nothing can send one', () => {
    expect(render({ onAcknowledge: undefined })).not.toContain('<button');
  });

  it('disables every button while one is being sent, and names the one in flight', () => {
    const html = render({ gaps: gaps({ gaps: [GAP, { ...GAP, id: 'event-10' }] }), acknowledging: 'event-9' });

    expect(html).toContain('Acknowledging');
    expect(html.match(/disabled/g)).toHaveLength(2);
  });

  it('shows the server’s sentence when an acknowledgement is refused', () => {
    const html = render({ error: 'Only members of the admins group can change an assessment.' });

    expect(html).toContain('Only members of the admins group');
    expect(html).toContain('role="alert"');
  });

  it('says the list is the newest when it was cut short', () => {
    expect(render({ gaps: gaps({ truncated: true }) })).toContain('This is the newest 1');
  });

  it('says it could not read the list rather than rendering nothing', () => {
    const html = render({ gaps: gaps({ gaps: [], unreadable: 'the database did not answer' }) });

    expect(html).toContain('could not be read');
    expect(html).toContain('the database did not answer');
    expect(html).not.toContain('<button');
  });

  it('renders nothing when there is nothing to acknowledge', () => {
    expect(render({ gaps: gaps({ gaps: [] }) })).toBe('');
  });
});
