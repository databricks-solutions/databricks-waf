// The trail's rows, asserted on the HTML they emit.
//
// Two kinds of empty matter more here than anywhere else in the app. "Nothing has been done yet" and
// "no acts match what you asked for" look identical if the page picks the wrong one, and on an audit
// surface the first is a claim: it says this install has never had anything done to it. A reader who
// has narrowed to one person's refusals and been told that would conclude the person was never refused.
//
// The rest of what is asserted is what a row is *for*. The sequence number is the act's own identity
// and what somebody quotes when they raise it; the reason is what turns a refusal from an event into a
// finding; an act with no object has to read as an act that never named one rather than as a cell the
// app failed to fill.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrailEvents } from './TrailEvents';
import type { AuditEvent, AuditTrail } from '../api/types';

function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    sequence: 41,
    at: '2026-07-30T09:41:00.000Z',
    actor: 'sam@example.com',
    executionMode: 'on-behalf-of-user',
    action: 'scan.start',
    outcome: 'performed',
    digest: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    ...over,
  };
}

function trail(over: Partial<AuditTrail> = {}): AuditTrail {
  return {
    durable: true,
    events: [event()],
    actions: [{ id: 'scan.start', phrase: 'start an assessment' }],
    ...over,
  };
}

function render(over: Partial<AuditTrail> = {}, narrowed = false) {
  return renderToStaticMarkup(
    <TrailEvents
      trail={trail(over)}
      narrowed={narrowed}
      onClear={() => {
        /* asserted on the button, not on the call */
      }}
    />
  );
}

describe('the trail rows', () => {
  it('says nothing matched, and offers a way back, when the reader narrowed it', () => {
    const html = render({ events: [] }, true);

    expect(html).toContain('data-empty-reason="filtered-out"');
    expect(html).toContain('match no event in the trail');
    expect(html).toContain('Clear filters');
    // The other empty state is a claim about the install, and it would be a false one here.
    expect(html).not.toContain('Nothing has been done yet');
  });

  it('says nothing has been done, without a clear button, when the trail itself is empty', () => {
    const html = render({ events: [] }, false);

    expect(html).toContain('data-empty-reason="not-yet-collected"');
    expect(html).toContain('Nothing has been done yet');
    // Reading the app records nothing, so an empty trail is the ordinary state of a new install
    // rather than a failure. The sentence has to say that or a reader reads it as one.
    expect(html).toContain('records events that change something');
    expect(html).not.toContain('Clear filters');
  });

  it('shows the act its own number, which is what a reader cites', () => {
    expect(render()).toContain('41');
  });

  it('names the act in the words the server sent rather than its identifier', () => {
    const html = render();

    expect(html).toContain('start an assessment');
    expect(html).not.toContain('scan.start');
  });

  /*
   * An act whose vocabulary this page was not told about still renders. The identifier is worse prose
   * than the phrase and better than a blank cell, and this is the shape of a client that has been open
   * across a deploy which added an act.
   */
  it('falls back to the identifier for an act it has no phrase for', () => {
    expect(render({ events: [event({ action: 'retention.sweep' })], actions: [] })).toContain('retention.sweep');
  });

  it('carries the reason beside a refusal, which is what makes it a finding', () => {
    const html = render({
      events: [event({ outcome: 'refused', reason: 'not-permitted' })],
    });

    expect(html).toContain('Refused');
    expect(html).toContain('not-permitted');
  });

  it('says an act named nothing rather than leaving the cell blank', () => {
    // The ordinary shape of a create that failed before it minted an id.
    expect(render({ events: [event({ outcome: 'failed', target: undefined })] })).toContain('Nothing yet named');
  });

  it('shows what an act was against, with what kind of thing it was', () => {
    const html = render({ events: [event({ target: { kind: 'scan', id: 'run-7' } })] });

    expect(html).toContain('run-7');
    expect(html).toContain('Run');
  });

  /*
   * A kind this build has no word for renders as the kind. Silently calling it "Record" would make a
   * new sort of object look like an old one, which is the failure the fallback exists to prevent.
   */
  it('shows an unfamiliar kind of target by its own name', () => {
    expect(render({ events: [event({ target: { kind: 'anonymisation', id: 'job-2' } })] })).toContain('anonymisation');
  });

  /*
   * Only when it is not a person. A note on every row saying "acting as themselves" is furniture; a
   * note on a row the app wrote under its own identity is the answer to "who authorised this".
   */
  it('notes the identity an act was performed under only when it is not the caller', () => {
    expect(render()).not.toContain('acting as');
    expect(render({ events: [event({ executionMode: 'service-principal' })] })).toContain('acting as');
  });

  it('carries the digest of a file that left, since that target cannot be looked up here', () => {
    // Every other kind of target is a record in this app. An exported file is somewhere else, and the
    // row is the only place a recipient's copy can be checked against what was served. The whole of
    // the digest is on the element rather than in the cell, so comparing sixty-four characters does
    // not cost the columns a reader came for.
    const digest = 'sha256:beef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab';
    const html = render({
      events: [event({ action: 'export.scan', target: { kind: 'artefact', id: 'well-architected.csv', digest } })],
    });

    expect(html).toContain('Exported file');
    expect(html).toContain('content beef12345678');
    expect(html).toContain(`title="${digest}"`);
  });

  it('says nothing about content for a target that is a record in this app', () => {
    // A digest of something already stored beside it would be a second copy of a value, which is a
    // way for the two to disagree.
    expect(render({ events: [event({ target: { kind: 'scan', id: 'run-7' } })] })).not.toContain('content ');
  });

  it('shortens the digest, since the whole of it is not what a reader compares by eye', () => {
    const html = render();

    expect(html).toContain('a1b2c3d4e5f6');
    expect(html).not.toContain('a1b2c3d4e5f60718');
  });
});
