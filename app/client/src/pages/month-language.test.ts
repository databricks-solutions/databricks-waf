import { describe, expect, it } from 'vitest';
import type { MonthSummary, PublishedMonth } from '../api/types';
import {
  COMPARABILITY_LABEL,
  DIGEST_NOTE,
  MIN_SUPERSEDE_REASON,
  monthRowCaption,
  monthTitle,
  navigatorMonths,
  NOT_DURABLE_NOTE,
  PREVIEW_NOTE,
  previousMonth,
  publishedBySentence,
  standingCountNote,
  standingPhrase,
  unclosedNote,
} from './month-language';

function published(over: Partial<PublishedMonth> = {}): PublishedMonth {
  return {
    id: 'pub-1',
    ordinal: 1,
    total: 1,
    current: true,
    publishedAt: '2026-09-01T09:00:00.000Z',
    publishedBy: 'priya@example.com',
    documentVersion: 1,
    digest: 'sha256:00',
    ...over,
  };
}

function summary(month: string, publications = 1): MonthSummary {
  return {
    month,
    label: monthTitle(month) ?? month,
    publications,
    standing: 1,
    latest: {
      id: `pub-${month}`,
      publishedAt: '2026-09-01T09:00:00.000Z',
      publishedBy: 'priya@example.com',
      digest: 'sha256:00',
    },
  };
}

describe('PREVIEW_NOTE', () => {
  it('says what the figures are and what publishing does to them', () => {
    expect(PREVIEW_NOTE).toContain('as it stands');
    expect(PREVIEW_NOTE).toContain('Publishing freezes');
    expect(PREVIEW_NOTE).not.toMatch(/sha256/i);
  });

  it('does not claim the estate is finished or that a run will fire', () => {
    expect(PREVIEW_NOTE).not.toMatch(/complete|will run|will fire|final/i);
  });
});

describe('DIGEST_NOTE', () => {
  it('is the integrity claim and not an origin claim', () => {
    expect(DIGEST_NOTE).toContain('not a signature');
    expect(DIGEST_NOTE).toContain('has this been altered');
    expect(DIGEST_NOTE).toContain('not “who wrote it”');
    expect(DIGEST_NOTE).not.toMatch(/who published|signature of origin/i);
  });
});

describe('standing', () => {
  it('names position and supersession from the fields, not a unique current copy', () => {
    expect(standingPhrase(published({ ordinal: 2, total: 3, current: false, supersededAt: '2026-09-12T00:00:00.000Z' }))).toBe(
      'Publication 2 of 3, superseded on 12 September 2026.'
    );
    expect(standingPhrase(published())).toBe('Publication 1 of 1, not superseded.');
  });

  it('does not say "the current publication"', () => {
    expect(standingPhrase(published())).not.toMatch(/\bthe current\b/i);
    expect(standingCountNote(2)).toBe('2 publications of this month are not superseded.');
    expect(standingCountNote(2)).not.toMatch(/\bthe\b.*publication/i);
    expect(standingCountNote(1)).toBeUndefined();
    expect(standingCountNote(0)).toBe('This month has not been published.');
  });
});

describe('publishedBySentence', () => {
  it('records who acted and says that is not approval', () => {
    expect(publishedBySentence('priya@example.com')).toBe(
      'Published by priya@example.com. That records who acted, not approval.'
    );
    expect(publishedBySentence('priya@example.com')).not.toMatch(/approved|approves|approving/i);
  });
});

describe('unclosedNote', () => {
  it('prefers the server sentence when one was supplied', () => {
    const fromServer =
      'August 2026 has not ended yet in UTC, the timezone the deployed schedule carries. A month is publishable only once it has closed, so that what it reports cannot change after it is frozen.';
    expect(
      unclosedNote('August 2026', '1 September 2026', { id: 'UTC', source: 'schedule' }, fromServer)
    ).toBe(fromServer);
  });

  it('does not call a default UTC the workspace timezone', () => {
    const note = unclosedNote('August 2026', '1 September 2026', { id: 'UTC', source: 'default' });
    expect(note).toContain("this app's default because no deployed schedule supplied one");
    expect(note).toContain('1 September 2026');
    expect(note).not.toMatch(/workspace timezone/i);
  });
});

describe('navigatorMonths', () => {
  it('includes the current month and the one before it even when unpublished', () => {
    expect(navigatorMonths('2026-08', [summary('2026-06')])).toEqual(['2026-08', '2026-07', '2026-06']);
  });

  it('does not invent months older than the previous unpublished one', () => {
    expect(navigatorMonths('2026-08', [])).toEqual(['2026-08', '2026-07']);
  });
});

describe('monthRowCaption', () => {
  it('restates the publication count, or that the month is still a preview', () => {
    expect(monthRowCaption('2026-07', '2026-08', [summary('2026-07', 2)])).toBe('2 publications');
    expect(monthRowCaption('2026-08', '2026-08', [])).toBe('Open');
    expect(monthRowCaption('2026-07', '2026-08', [])).toBe('Not published');
  });
});

describe('labels', () => {
  it('names a month from its digits', () => {
    expect(monthTitle('2026-08')).toBe('August 2026');
    expect(monthTitle('2026-13')).toBeUndefined();
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-08')).toBe('2026-07');
  });

  it('keeps comparability as three outcomes, not two', () => {
    expect(COMPARABILITY_LABEL.permitted).toBe('Comparable');
    expect(COMPARABILITY_LABEL.caveat).toContain('caveat');
    expect(COMPARABILITY_LABEL.refused).toBe('Not comparable');
  });

  it('uses the same reason floor the publish route does', () => {
    expect(MIN_SUPERSEDE_REASON).toBe(12);
  });

  it('does not promise a Lakebase bind from durable: false', () => {
    expect(NOT_DURABLE_NOTE).toContain('cannot be published');
    expect(NOT_DURABLE_NOTE).not.toMatch(/Lakebase|bind/i);
  });
});
