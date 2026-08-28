// The sentence, asserted rather than eyeballed.
//
// It is one line on a detail pane, and it is the line a customer quotes back when they disagree with
// a number. Getting the authority wrong in it is the expensive mistake: telling a reader a figure was
// read with their own permissions when it was read with the app's sends them to check something that
// will agree with them, and they will conclude the app is wrong rather than that they cannot see what
// it saw.

import { describe, expect, it } from 'vitest';
import { collectorNote, provenanceSentence } from './provenance-language';
import type { Provenance } from '../api/types';

const READ: Provenance = {
  surface: 'describe',
  collector: 'table-detail',
  authority: 'on-behalf-of-user',
  actor: 'alice@example.com',
  from: 'warehouse abc123',
};

describe('the provenance sentence', () => {
  it('names the person, their permissions and the place, in one line', () => {
    expect(provenanceSentence(READ)).toBe(
      'Read as alice@example.com, with your own permissions, from warehouse abc123.'
    );
  });

  it('distinguishes the three authorities, because they see three different estates', () => {
    const says = (authority: Provenance['authority'], actor: string) =>
      provenanceSentence({ ...READ, authority, actor }) ?? '';

    expect(says('on-behalf-of-user', 'alice@example.com')).toContain('your own permissions');
    expect(says('service-principal', 'app-1234')).toContain('as the service principal app-1234');
    expect(says('service-credential', 'prod-storage-reader')).toContain('prod-storage-reader service credential');
  });

  it('does not say whose service principal read, since the field does not carry that', () => {
    // A scheduled run authenticates as whichever principal the customer created for it, and this
    // sentence said "the app's" — true only while nothing ever set the mode to `service-principal`.
    // Row 40f set it, and the labs run on the day it landed stamped 75 readings this way, every one
    // of them the customer's `waf-schedule-probe`.
    const said = provenanceSentence({ ...READ, authority: 'service-principal', actor: 'app-1234' }) ?? '';

    expect(said).toContain('app-1234');
    expect(said).not.toMatch(/\bapp['’]s\b|\bour\b|\bown\b/);
  });

  it('drops the place rather than hedging it, when none was recorded', () => {
    const { from: _absent, ...noPlace } = READ;

    expect(provenanceSentence(noPlace)).toBe('Read as alice@example.com, with your own permissions.');
  });

  it('says nothing at all for a reading that carries no attribution', () => {
    // Evidence from a fixture, or carried forward from a scan recorded before this existed. "Read as
    // unknown" would send somebody looking for an identity that was never written down.
    expect(provenanceSentence(undefined)).toBeUndefined();
    expect(collectorNote(undefined)).toBeUndefined();
  });
});

describe('the collector note', () => {
  it('names the code that produced the reading, for whoever has to explain it', () => {
    expect(collectorNote(READ)).toBe('table-detail collector on the describe surface');
  });
});
