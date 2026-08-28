// What a summary counts, and what it declines to read back.
//
// `summaryFrom` is the half worth testing hardest. It guards a stored value that a previous version of
// this app wrote, and the failure it exists to prevent is silent: a summary read back with a field
// missing would render as a zero, and a zero in the observed column is a sentence — "this collection
// found nothing" — that the file never said.

import { describe, expect, it } from 'vitest';
import { envelope, probe } from './envelope-fixture.js';
import { envelopeFrom, type Envelope } from './envelope.js';
import { summarise, summaryFrom } from './summary.js';

function sealed(overrides: Record<string, unknown> = {}): Envelope {
  return envelopeFrom(envelope(overrides));
}

describe('summarising an envelope', () => {
  it('counts a probe that returned a reading as observed', () => {
    expect(summarise(sealed()).observed).toBe(1);
  });

  it('counts refusals and errors together, and neither as a skip', () => {
    const summary = summarise(
      sealed({
        probes: [
          probe({ label: 'a', status: 'denied', value: undefined, reason: 'Refused.' }),
          probe({ label: 'b', status: 'error', value: undefined, reason: 'Failed.' }),
          probe({ label: 'c', status: 'skipped', value: undefined, reason: 'Not run.' }),
        ],
      })
    );

    // Three probes, none observed, and the skip is in neither count. A skipped probe is one the
    // script chose not to run, which says nothing about whether the platform would have allowed it.
    expect(summary.observed).toBe(0);
    expect(summary.refused).toBe(2);
  });

  it('counts a requirement once however many probes speak to it', () => {
    const summary = summarise(
      sealed({
        probes: [
          probe({ label: 'a', controls: ['SCP-01-04', 'SCP-02-01'] }),
          probe({ label: 'b', controls: ['SCP-02-01'] }),
        ],
      })
    );

    expect(summary.requirements).toBe(2);
  });

  it('carries the collection time as the file wrote it', () => {
    const held = sealed();
    expect(summarise(held).generatedAt).toBe(held.generatedAt);
  });
});

describe('reading a stored summary back', () => {
  it('round-trips one it wrote, through the JSON the column holds', () => {
    const summary = summarise(sealed());
    expect(summaryFrom(JSON.parse(JSON.stringify(summary)))).toStrictEqual(summary);
  });

  it('declines a summary missing a count rather than reading the gap as none', () => {
    const { observed: _dropped, ...without } = summarise(sealed());
    expect(summaryFrom(without)).toBeUndefined();
  });

  it('declines a count that is not a whole number, since a page renders it as one', () => {
    expect(summaryFrom({ ...summarise(sealed()), observed: 1.5 })).toBeUndefined();
  });

  it('declines anything that is not an object, including the null a legacy row holds', () => {
    expect(summaryFrom(null)).toBeUndefined();
    expect(summaryFrom(undefined)).toBeUndefined();
    expect(summaryFrom('{}')).toBeUndefined();
    expect(summaryFrom([summarise(sealed())])).toBeUndefined();
  });

  it('keeps an absent collector absent rather than inventing one', () => {
    // The CLI cannot always name who it authenticated as. Absent has to survive the round trip,
    // because a blank string in that column reads as a person with no name.
    const { collectedBy: _dropped, ...anonymous } = summarise(sealed());
    const read = summaryFrom(anonymous);
    expect(read).toBeDefined();
    expect(read?.collectedBy).toBeUndefined();
  });
});
