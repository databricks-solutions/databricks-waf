import { describe, expect, it } from 'vitest';
import {
  inPublishedOrder,
  monthLabel,
  monthOpensOn,
  parseMonth,
  supersededBy,
  unsuperseded,
  type MonthId,
  type Publication,
} from './publication.js';

function month(raw: string): MonthId {
  const parsed = parseMonth(raw);
  if (parsed == null) throw new Error(`test wants a valid month, ${raw} is not one`);
  return parsed;
}

function publication(over: Partial<Publication> = {}): Publication {
  return {
    id: 'pub-1',
    month: month('2026-08'),
    publishedAt: new Date('2026-09-01T09:00:00.000Z'),
    publishedBy: 'ana@example.com',
    documentVersion: 1,
    json: '{}',
    csv: '',
    digest: 'sha256:00',
    ...over,
  };
}

describe('parsing a month', () => {
  it('accepts YYYY-MM with the month in range', () => {
    expect(parseMonth('2026-08')).toBe('2026-08');
    expect(parseMonth('2026-01')).toBe('2026-01');
    expect(parseMonth('2026-12')).toBe('2026-12');
  });

  it('refuses a month out of range, a wrong shape, or a non-string', () => {
    for (const bad of ['2026-00', '2026-13', '2026-8', '2026/08', 'August', '2026-08-01', '']) {
      expect(parseMonth(bad)).toBeUndefined();
    }
    expect(parseMonth(202608)).toBeUndefined();
    expect(parseMonth(null)).toBeUndefined();
  });

  it('refuses a longer string that merely starts with a valid month', () => {
    // Anchored, or a filename or an injected value carrying a valid prefix would pass and reach the
    // bytes as something other than a month.
    expect(parseMonth('2026-08 and more')).toBeUndefined();
  });
});

describe('the label a reader sees', () => {
  it('names the month and the year from the digits, not a locale', () => {
    expect(monthLabel(month('2026-08'))).toBe('August 2026');
    expect(monthLabel(month('2026-01'))).toBe('January 2026');
    expect(monthLabel(month('2025-12'))).toBe('December 2025');
  });

  it('names the first of the next month as the date publish becomes available', () => {
    expect(monthOpensOn(month('2026-08'))).toBe('1 September 2026');
    expect(monthOpensOn(month('2026-12'))).toBe('1 January 2027');
    expect(monthOpensOn(month('2026-01'))).toBe('1 February 2026');
  });
});

describe('what supersedes what', () => {
  const first = publication({ id: 'a', publishedAt: new Date('2026-09-01T09:00:00.000Z') });
  const correction = publication({
    id: 'b',
    publishedAt: new Date('2026-09-05T09:00:00.000Z'),
    supersedes: 'a',
    reason: 'A run repaired after the first publication.',
  });

  it('reads a supersession from the publication that claims it', () => {
    expect(unsuperseded([correction, first]).map((one) => one.id)).toEqual(['b']);
    expect(supersededBy(first, [first, correction])?.id).toBe('b');
    expect(supersededBy(correction, [first, correction])).toBeUndefined();
  });

  it('reads two publications that name nothing as two that nothing superseded', () => {
    // A month that took two first publications before the store refused them. Neither says anything about
    // the other, so neither was superseded — and reading the earlier one as superseded because something
    // came after it is the read path inventing a history the record does not hold.
    const other = publication({ id: 'c', publishedAt: new Date('2026-09-09T09:00:00.000Z') });

    expect(unsuperseded([first, other]).map((one) => one.id)).toEqual(['a', 'c']);
    expect(supersededBy(first, [first, other])).toBeUndefined();
  });

  it('is in publication order, so a caller reporting several reads them the way they were published', () => {
    const other = publication({ id: 'c', publishedAt: new Date('2026-08-09T09:00:00.000Z') });

    expect(unsuperseded([first, other]).map((one) => one.id)).toEqual(['c', 'a']);
  });
});

describe('publication order', () => {
  it('is oldest first, so the last is the current publication', () => {
    const first = publication({ id: 'a', publishedAt: new Date('2026-09-01T09:00:00.000Z') });
    const second = publication({ id: 'b', publishedAt: new Date('2026-09-05T09:00:00.000Z') });
    const ordered = inPublishedOrder([second, first]);
    expect(ordered.map((one) => one.id)).toEqual(['a', 'b']);
  });

  it('breaks a same-instant tie on the id, so the order is stable across reads', () => {
    const at = new Date('2026-09-01T09:00:00.000Z');
    const x = publication({ id: 'x', publishedAt: at });
    const y = publication({ id: 'y', publishedAt: at });
    expect(inPublishedOrder([y, x]).map((one) => one.id)).toEqual(['x', 'y']);
    expect(inPublishedOrder([x, y]).map((one) => one.id)).toEqual(['x', 'y']);
  });

  it('does not mutate the array it was given', () => {
    const first = publication({ id: 'a', publishedAt: new Date('2026-09-01T09:00:00.000Z') });
    const second = publication({ id: 'b', publishedAt: new Date('2026-09-05T09:00:00.000Z') });
    const input = [second, first];
    inPublishedOrder(input);
    expect(input.map((one) => one.id)).toEqual(['b', 'a']);
  });
});
