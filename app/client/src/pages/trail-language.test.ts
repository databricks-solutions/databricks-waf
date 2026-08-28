import { describe, expect, it } from 'vitest';
import {
  OUTCOME_LABEL,
  digestBrief,
  executionPhrase,
  headSentence,
  momentOf,
  outcomePresentation,
  rangeSentence,
  targetLabel,
  verificationPresentation,
} from './trail-language';
import type { AuditEvent, AuditTrail, AuditVerification } from '../api/types';

function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    sequence: 412,
    at: '2026-08-04T09:41:07.000Z',
    actor: 'priya@example.com',
    executionMode: 'on-behalf-of-user',
    action: 'scan.start',
    outcome: 'performed',
    digest: 'sha256:0af993a2d134d37fedd0f036ae77a212c0e04f6d1ee5cb9b3144058fafe8ec86',
    ...over,
  };
}

function trail(events: readonly AuditEvent[], over: Partial<AuditTrail> = {}): AuditTrail {
  return {
    durable: true,
    events,
    actions: [{ id: 'scan.start', phrase: 'start a scan' }],
    ...over,
  };
}

function verification(over: Partial<AuditVerification> = {}): AuditVerification {
  return { checked: 412, breaks: [], means: 'Every event matches its own digest.', ...over };
}

describe('an outcome', () => {
  it('keeps refused and failed apart, since one is the app working and the other is not', () => {
    expect(OUTCOME_LABEL.refused).not.toBe(OUTCOME_LABEL.failed);
  });

  it('does not colour a refusal as a fault', () => {
    // A refusal is the gate doing what it was built to do. Colouring it as an error teaches a reader
    // to treat this page's alarming rows as normal, after which the alarming row says nothing.
    expect(outcomePresentation('refused').tone).not.toBe('danger');
    expect(outcomePresentation('performed').tone).toBe('success');
  });
});

describe('a target', () => {
  it('is named in the reader\u2019s terms rather than the app\u2019s', () => {
    expect(targetLabel('scan')).toBe('Run');
    expect(targetLabel('control')).toBe('Requirement');
  });

  it('renders an unrecognised kind as itself rather than as a record', () => {
    // `event.ts` may grow a seventh kind before this file hears about it, and a map that returned
    // "Record" for anything it did not know would make a new kind of object look like an old one.
    expect(targetLabel('improvement-plan')).toBe('improvement-plan');
  });
});

describe('how the caller was acting', () => {
  it('says nothing for a person, because that is the ordinary case', () => {
    expect(executionPhrase('on-behalf-of-user')).toBeUndefined();
  });

  it('says so when it was the app under its own identity', () => {
    expect(executionPhrase('service-principal')).toBe("the app's own identity");
  });
});

describe('a moment', () => {
  it('is written to the second, so two acts in one minute can be ordered', () => {
    const written = momentOf('2026-08-04T09:41:07.000Z');

    expect(written).toMatch(/07/);
    expect(written).not.toBe('an unknown time');
  });

  it('does not throw on a stamp it cannot read', () => {
    expect(momentOf('not a time')).toBe('an unknown time');
  });
});

describe('a digest', () => {
  it('drops the algorithm prefix, which is the same on every row', () => {
    expect(digestBrief('sha256:0af993a2d134')).toBe('0af993a2d134');
  });

  it('is short enough to compare by eye and too short to verify with', () => {
    expect(digestBrief(event().digest)).toHaveLength(12);
  });
});

describe('the head sentence', () => {
  it('tells the reader to record the head somewhere this app cannot reach', () => {
    // The whole value of the head is that it is held outside. A chain that verifies itself is not
    // evidence against the app that wrote it, and the sentence is the only place that is said.
    const said = headSentence({ sequence: 412, digest: event().digest });

    expect(said).toContain('412');
    expect(said).toContain('outside this app');
  });
});

describe('the verification badge', () => {
  it('reads as broken when the chain is', () => {
    expect(
      verificationPresentation(
        verification({
          breaks: [{ sequence: 9, kind: 'digest', says: 'The stored digest is not the digest of this event.' }],
        })
      ).tone
    ).toBe('danger');
  });

  it('does not claim an intact chain when there was nothing to check', () => {
    // A vacuous pass on an empty log is the one result that must not read as a verified history.
    expect(verificationPresentation(verification({ checked: 0 })).label).toBe('Nothing to check');
  });

  it('claims intact only when something was checked and nothing broke', () => {
    expect(verificationPresentation(verification()).label).toBe('Chain intact');
  });
});

describe('the range sentence', () => {
  it('spans by sequence rather than by row, because the sequence is what a reader quotes', () => {
    const said = rangeSentence(
      trail([event({ sequence: 412 }), event({ sequence: 393 })], { head: { sequence: 412, digest: event().digest } })
    );

    expect(said).toBe('Events 412 down to 393 of 412 recorded');
  });

  it('does not say "412 down to 412" for a single event', () => {
    expect(rangeSentence(trail([event({ sequence: 412 })]))).toBe('Event 412');
  });

  it('says nothing matched rather than naming a range it does not have', () => {
    expect(rangeSentence(trail([]))).toBe('No events match');
  });
});
