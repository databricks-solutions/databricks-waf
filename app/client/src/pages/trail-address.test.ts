// The address bar, which on the trail page is the whole statement of what is being read.
//
// Every failure these cover shows the reader an empty table and no reason for it, which on an audit
// surface is indistinguishable from "nothing happened". That is the whole point of testing them: a
// filter that keeps a stale cursor and a trail with genuinely no matching acts render the same page.

import { describe, expect, it } from 'vitest';
import { atPage, isNarrowed, NARROWING, requested, withFilter, withoutNarrowing } from './trail-address';

describe('withFilter', () => {
  it('drops the cursor, so a filter is not applied to one page of the chain', () => {
    const next = withFilter(new URLSearchParams('outcome=refused&before=120'), 'actor', 'sam@example.com');

    expect(next.get('actor')).toBe('sam@example.com');
    expect(next.get('outcome')).toBe('refused');
    // Kept, `before=120` would have hidden every matching act above 120 behind an empty page.
    expect(next.has('before')).toBe(false);
  });

  it('removes a filter rather than writing an empty one', () => {
    expect(withFilter(new URLSearchParams('actor=sam@example.com'), 'actor', '').has('actor')).toBe(false);
  });

  it('treats the any-value a select carries as no filter at all', () => {
    // `action=all` would be forwarded to the store, which has no such action, and match nothing.
    expect(withFilter(new URLSearchParams('action=scan.start'), 'action', 'all').has('action')).toBe(false);
  });

  it('leaves parameters this page does not own alone', () => {
    expect(withFilter(new URLSearchParams('theme=dark'), 'outcome', 'failed').get('theme')).toBe('dark');
  });
});

describe('atPage', () => {
  it('names the cursor the server gave and keeps the filters it was given under', () => {
    const next = atPage(new URLSearchParams('actor=sam@example.com&before=200'), 120);

    expect(next.get('before')).toBe('120');
    expect(next.get('actor')).toBe('sam@example.com');
  });

  it('returns to the newest page by removing the cursor, not by naming a high one', () => {
    // A large `before` would be a guess about where the chain ends, and the chain grows.
    expect(atPage(new URLSearchParams('before=120')).has('before')).toBe(false);
  });
});

describe('withoutNarrowing', () => {
  it('clears every parameter that narrows, including ones the filter strip has no control for', () => {
    const next = withoutNarrowing(
      new URLSearchParams(
        'actor=sam@example.com&action=scan.start&outcome=refused&target=run-1&since=2026-01-01&until=2026-02-01&correlation=c1&before=120'
      )
    );

    expect([...next.keys()]).toEqual([]);
  });

  it('keeps what is not a narrowing, so clearing filters is not clearing the query string', () => {
    const next = withoutNarrowing(new URLSearchParams('actor=sam@example.com&theme=dark'));

    expect(next.get('theme')).toBe('dark');
    expect(next.has('actor')).toBe(false);
  });
});

describe('isNarrowed', () => {
  it('is false for the whole trail', () => {
    expect(isNarrowed(new URLSearchParams())).toBe(false);
    // Not a narrowing: it is a fact about the window, and it is not in the address anyway.
    expect(isNarrowed(new URLSearchParams('limit=20'))).toBe(false);
  });

  it('is true for every parameter the store accepts, not only the three with controls', () => {
    for (const filter of NARROWING) {
      expect(isNarrowed(new URLSearchParams(`${filter}=x`)), filter).toBe(true);
    }
  });

  /*
   * A hand-written `since` that matches nothing is the case this exists for. Without it the page tells
   * a reader on a full install that nothing has ever been done, and offers no way to undo the parameter
   * that caused it.
   */
  it('counts an empty value as narrowing, because the store is what decides what it matches', () => {
    expect(isNarrowed(new URLSearchParams('correlation='))).toBe(true);
  });
});

describe('requested', () => {
  it('adds the measured page size to the request', () => {
    expect(new URLSearchParams(requested(new URLSearchParams('outcome=refused'), 18)).get('limit')).toBe('18');
  });

  it('does not put it in the address it was given', () => {
    const params = new URLSearchParams('outcome=refused');
    requested(params, 18);

    expect(params.has('limit')).toBe(false);
  });

  it('replaces a limit somebody put in the address by hand, rather than sending two', () => {
    const asked = new URLSearchParams(requested(new URLSearchParams('limit=500'), 18));

    expect(asked.getAll('limit')).toEqual(['18']);
  });
});
