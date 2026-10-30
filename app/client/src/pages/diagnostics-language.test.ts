import { describe, expect, it } from 'vitest';
import {
  agoPhrase,
  DEPENDENCY_LABEL,
  gapOutcomePhrase,
  gapsSentence,
  healthSentence,
  provenancePhrase,
  standingPresentation,
  unrecordedSentence,
} from './diagnostics-language';
import type { Diagnostics, HealthReading } from '../api/types';

function reading(over: Partial<HealthReading> = {}): HealthReading {
  return {
    dependency: 'database',
    standing: 'answering',
    provenance: 'probed',
    at: '2026-08-04T09:00:00.000Z',
    detail: 'The database answered.',
    ...over,
  };
}

function health(readings: readonly HealthReading[], over: Partial<Diagnostics> = {}): Diagnostics {
  return { at: '2026-08-04T09:00:00.000Z', well: true, unrecorded: 0, readings, ...over };
}

describe('the health sentence', () => {
  it('names what is wrong rather than counting it', () => {
    // "Two of four dependencies are degraded" is a statistic. A name is a next step.
    const sentence = healthSentence(
      health([reading({ dependency: 'database', standing: 'silent' }), reading({ dependency: 'warehouse' })], {
        well: false,
      })
    );

    expect(sentence).toContain('Database (silent)');
    expect(sentence).not.toContain('1 of');
  });

  it('names every fault, so fixing the first does not surface the second as new', () => {
    const sentence = healthSentence(
      health(
        [
          reading({ dependency: 'database', standing: 'silent' }),
          reading({ dependency: 'audit-log', standing: 'degraded' }),
        ],
        { well: false }
      )
    );

    expect(sentence).toContain('Database (silent)');
    expect(sentence).toContain('Audit trail (degraded)');
    expect(sentence).toContain(' and ');
  });

  it('separates nothing bound from nothing failing, because they are different states', () => {
    const sentence = healthSentence(health([reading({ dependency: 'warehouse', standing: 'unbound' }), reading()]));

    expect(sentence).toContain('Nothing is failing');
    expect(sentence).toContain('SQL warehouse');
    expect(sentence).toContain('unavailable rather than broken');
  });

  it('does not treat a reading nothing could take as a fault', () => {
    // An install with no forwarded token is not a broken install, and reporting it as one would teach
    // the reader to ignore this line on the installs where it means something.
    const sentence = healthSentence(health([reading({ dependency: 'identity', standing: 'unknown' }), reading()]));

    expect(sentence).toBe('Everything this app depends on is answering, or was the last time anything used it.');
  });
});

describe('the provenance phrase', () => {
  it('says a probe was taken now and dates an observation', () => {
    const now = new Date('2026-08-04T09:00:00.000Z');

    expect(provenancePhrase(reading(), now)).toBe('Checked just now');
    expect(provenancePhrase(reading({ provenance: 'observed', at: '2026-08-03T22:00:00.000Z' }), now)).toBe(
      'Observed 11 hours ago'
    );
  });
});

describe('how long ago', () => {
  const now = new Date('2026-08-04T09:00:00.000Z');

  it('answers in the coarsest unit that still answers the question', () => {
    expect(agoPhrase(new Date('2026-08-04T08:59:30.000Z'), now)).toBe('just now');
    expect(agoPhrase(new Date('2026-08-04T08:59:00.000Z'), now)).toBe('1 minute ago');
    expect(agoPhrase(new Date('2026-08-04T08:30:00.000Z'), now)).toBe('30 minutes ago');
    expect(agoPhrase(new Date('2026-08-04T08:00:00.000Z'), now)).toBe('1 hour ago');
    expect(agoPhrase(new Date('2026-08-03T09:00:00.000Z'), now)).toBe('24 hours ago');
    expect(agoPhrase(new Date('2026-07-30T09:00:00.000Z'), now)).toBe('5 days ago');
  });

  it('does not report a clock skew as a reading from the future', () => {
    // The app's clock and the reader's are different clocks. "In -3 minutes" is not a diagnosis.
    expect(agoPhrase(new Date('2026-08-04T09:03:00.000Z'), now)).toBe('just now');
  });

  it('says so rather than printing NaN when a date cannot be read', () => {
    expect(agoPhrase(new Date('not a date'), now)).toBe('at an unknown time');
  });
});

describe('what could not be recorded', () => {
  it('says nothing when nothing was missed, rather than reassuring about a fault that never was', () => {
    expect(unrecordedSentence(0)).toBeUndefined();
  });

  it('says it cannot be recovered, because that is the part that changes what the reader does', () => {
    const sentence = unrecordedSentence(1);

    expect(sentence).toContain('1 action');
    expect(sentence).toContain('was not written');
    expect(sentence).toContain('cannot be recovered');
    expect(unrecordedSentence(4)).toContain('4 actions');
  });

  it('labels the count as this instance’s, since it is held in memory and another instance has its own', () => {
    expect(unrecordedSentence(2)).toContain('since this instance last started');
    expect(unrecordedSentence(2)).not.toContain('this app last started');
  });
});

describe('what the trail is missing that a restart did not erase', () => {
  it('says nothing when every gap is acknowledged', () => {
    expect(gapsSentence({ gaps: [], truncated: false })).toBeUndefined();
    expect(gapsSentence(undefined)).toBeUndefined();
  });

  it('counts the gaps and says they are held in the database, whichever instance lost them', () => {
    const gap = {
      id: 'event-9',
      at: '2026-08-03T11:30:00.000Z',
      actor: 'dana@example.com',
      action: 'attestation.record',
      phrase: 'answer a requirement',
      outcome: 'performed' as const,
      cause: 'AuditAppendError',
    };

    expect(gapsSentence({ gaps: [gap], truncated: false })).toContain('1 lost audit event');
    const two = gapsSentence({ gaps: [gap, { ...gap, id: 'event-10' }], truncated: false });
    expect(two).toContain('2 lost audit events');
    expect(two).toContain('any instance');
  });

  it('says at least when the list was cut short', () => {
    const gap = {
      id: 'event-9',
      at: '2026-08-03T11:30:00.000Z',
      actor: 'dana@example.com',
      action: 'attestation.record',
      phrase: 'answer a requirement',
      outcome: 'performed' as const,
      cause: 'AuditAppendError',
    };

    expect(gapsSentence({ gaps: [gap], truncated: true })).toContain('At least 1');
  });

  it('puts an outcome in words, so a lost refusal is not read as a lost change', () => {
    expect(gapOutcomePhrase('performed')).toBe('went ahead');
    expect(gapOutcomePhrase('refused')).toBe('was refused');
    expect(gapOutcomePhrase('failed')).toBe('did not complete');
  });
});

describe('the presentation of a standing', () => {
  it('gives every standing a shape as well as a tone', () => {
    // Colour alone is insufficient, and a badge that could omit its shape is one that will.
    for (const standing of ['answering', 'degraded', 'silent', 'unbound', 'unknown'] as const) {
      expect(standingPresentation(standing).Icon).toBeDefined();
    }
  });

  it('keeps nothing-bound neutral, so a fresh install is not coloured as a fault', () => {
    expect(standingPresentation('unbound').tone).toBe('neutral');
    expect(standingPresentation('unknown').tone).toBe('neutral');
    expect(standingPresentation('silent').tone).toBe('danger');
  });
});

describe('the dependency labels', () => {
  it('uses the words the resource form uses, not the internal ones', () => {
    // A page that names the thing differently from the form it sends somebody to adds a translation
    // step to every fix.
    expect(DEPENDENCY_LABEL.database).toBe('Database');
    expect(DEPENDENCY_LABEL.warehouse).toBe('SQL warehouse');
  });
});
