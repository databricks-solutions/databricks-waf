import { describe, expect, it } from 'vitest';
import { fromBytes } from '../records/digest.js';
import { parseMonth, type MonthId, type PublicationIdentity } from './publication.js';
import {
  MONTH_DOCUMENT_KIND,
  MONTH_DOCUMENT_VERSION,
  monthCsv,
  monthDocument,
  monthJson,
  type MonthContent,
} from './document.js';

function month(raw: string): MonthId {
  const parsed = parseMonth(raw);
  if (parsed == null) throw new Error(`test wants a valid month, ${raw} is not one`);
  return parsed;
}

function identity(over: Partial<PublicationIdentity> = {}): PublicationIdentity {
  return {
    id: 'pub-1',
    month: month('2026-08'),
    publishedAt: new Date('2026-09-01T09:00:00.000Z'),
    publishedBy: 'ana@example.com',
    ...over,
  };
}

function content(over: Partial<MonthContent> = {}): MonthContent {
  return {
    assessment: {
      runId: 'run-1',
      reviewId: 'review-1',
      finalResultId: 'result-1',
      definition: { id: 'definition-1', version: 2, fingerprint: 'sha256:definition-1-v2' },
    },
    runHealth: [{ label: 'Scheduled runs', value: '4 of 4 succeeded' }],
    findingDeltas: [
      { control: 'SEC-01-02', requirement: 'Encrypt at rest', pillar: 'Security', from: 'fail', to: 'pass' },
    ],
    movement: [{ label: 'Coverage', from: '88%', to: '91%' }],
    actions: [{ label: 'Opened', value: '3' }],
    exceptions: [
      {
        control: 'REL-02-04',
        requirement: 'Multi-region',
        owner: 'priya@example.com',
        residual: 'single region for now',
        until: '2026-12-01',
      },
    ],
    outcomes: [{ label: 'Fixed', value: '2' }],
    review: [{ label: 'Review', value: 'Finalised by ana@example.com' }],
    trend: [{ month: month('2026-08'), label: 'August 2026', score: '74', comparability: 'permitted' }],
    ...over,
  };
}

describe('the frozen document', () => {
  it('carries the format kind, the version, and the publication identity in its bytes', () => {
    const document = monthDocument(identity(), content());
    expect(document.documentKind).toBe(MONTH_DOCUMENT_KIND);
    expect(document.documentVersion).toBe(MONTH_DOCUMENT_VERSION);
    expect(document.publication.id).toBe('pub-1');
    expect(document.publication.month).toBe('2026-08');
    // Baked in, so a superseded copy forwarded on has itself to say what it is.
    expect(document.publication.publishedAt).toBe('2026-09-01T09:00:00.000Z');
    expect(document.publication.monthLabel).toBe('August 2026');
    expect(document.assessment).toEqual({
      runId: 'run-1',
      reviewId: 'review-1',
      finalResultId: 'result-1',
      definition: { id: 'definition-1', version: 2, fingerprint: 'sha256:definition-1-v2' },
    });
  });

  it('omits assessment identity where no final result closed the month', () => {
    expect(monthDocument(identity(), content({ assessment: undefined })).assessment).toBeUndefined();
  });

  it('carries a supersession reason only when it supersedes something', () => {
    const first = monthDocument(identity(), content());
    expect(first.publication.supersedes).toBeUndefined();
    expect(first.publication.reason).toBeUndefined();

    const correction = monthDocument(
      identity({ id: 'pub-2', supersedes: 'pub-1', reason: 'A run repaired after the first publication.' }),
      content()
    );
    expect(correction.publication.supersedes).toBe('pub-1');
    expect(correction.publication.reason).toBe('A run repaired after the first publication.');
  });

  it('is a pure function of its input: the same publication builds the same bytes and digest', () => {
    // The property the whole record type rests on. Two builds of one publication have to be
    // byte-identical, or a digest recorded at publish would not match the document read back.
    const first = monthJson(monthDocument(identity(), content()));
    const second = monthJson(monthDocument(identity(), content()));
    expect(second).toBe(first);
    expect(fromBytes(Buffer.from(second, 'utf8'))).toBe(fromBytes(Buffer.from(first, 'utf8')));
  });

  it('resolves nothing at build time: the bytes contain only strings it was handed', () => {
    // Denormalisation, made checkable. Every displayed string is in the input, so a catalogue change
    // that alters a title later cannot reach a published month — the builder never looks a title up.
    const bytes = monthJson(monthDocument(identity(), content()));
    expect(bytes).toContain('Encrypt at rest');
    expect(bytes).toContain('Security');
    const renamed = content({
      findingDeltas: [{ control: 'SEC-01-02', requirement: 'Renamed', pillar: 'Security', from: 'fail', to: 'pass' }],
    });
    const other = monthJson(monthDocument(identity(), renamed));
    // A different input gives different bytes; the same input never does. There is no third source.
    expect(other).not.toBe(bytes);
    expect(other).toContain('Renamed');
  });
});

describe('the document version', () => {
  it('is 2, the version whose movement sections are published only between comparable readings', () => {
    expect(MONTH_DOCUMENT_VERSION).toBe(2);
    expect(monthDocument(identity(), content()).documentVersion).toBe(2);
  });

  it('carries which reading closed the month, and why a movement is not shown', () => {
    const document = monthDocument(
      identity(),
      content({
        closing: {
          kind: 'latest-scan',
          statement:
            'No scheduled run finished in August 2026, so the month closes on its latest scan, which was started by hand.',
        },
        movement: [],
        findingDeltas: [],
        movementNote:
          'Movement and finding changes are not shown: no earlier scan can be compared with the run that closed the month.',
      })
    );

    expect(document.closing?.kind).toBe('latest-scan');
    expect(document.movementNote).toContain('not shown');
  });

  it('writes neither key where the content has neither', () => {
    const bytes = monthJson(monthDocument(identity(), content()));

    expect(bytes).not.toContain('"closing"');
    expect(bytes).not.toContain('"movementNote"');
  });

  it('writes the closing statement and the movement note into the CSV', () => {
    const csv = monthCsv(
      monthDocument(
        identity(),
        content({
          closing: {
            kind: 'scheduled',
            statement: 'The month closes on its latest scheduled run, the system of record.',
          },
          movement: [],
          movementNote: 'Movement and finding changes are not shown: nothing to compare.',
        })
      )
    );

    expect(csv).toContain(
      'closing,Closing reading,scheduled,,"The month closes on its latest scheduled run, the system of record."'
    );
    expect(csv).toContain('movement,Not shown,,,Movement and finding changes are not shown: nothing to compare.');
  });
});

describe('the bytes of a version 2 document', () => {
  // Pinned so that a change to the canonical form, the key set or the wording of a section shows up here
  // as a change to the bytes, and with them every digest a publication records.
  it('are exactly these', () => {
    const document = monthDocument(
      identity(),
      content({
        closing: {
          kind: 'scheduled',
          statement: 'The month closes on its latest scheduled run, the system of record.',
        },
        movement: [],
        findingDeltas: [],
        movementNote:
          'Movement and finding changes are not shown: no earlier scan can be compared with the run that closed the month. These scans ran as different identities (sp-schedule and ana@example.com), whose visible estates may differ.',
      })
    );

    expect(monthJson(document)).toMatchInlineSnapshot(
      `"{"actions":[{"label":"Opened","value":"3"}],"assessment":{"definition":{"fingerprint":"sha256:definition-1-v2","id":"definition-1","version":2},"finalResultId":"result-1","reviewId":"review-1","runId":"run-1"},"closing":{"kind":"scheduled","statement":"The month closes on its latest scheduled run, the system of record."},"documentKind":"databricks-waf-month","documentVersion":2,"exceptions":[{"control":"REL-02-04","owner":"priya@example.com","requirement":"Multi-region","residual":"single region for now","until":"2026-12-01"}],"findingDeltas":[],"movement":[],"movementNote":"Movement and finding changes are not shown: no earlier scan can be compared with the run that closed the month. These scans ran as different identities (sp-schedule and ana@example.com), whose visible estates may differ.","outcomes":[{"label":"Fixed","value":"2"}],"publication":{"id":"pub-1","month":"2026-08","monthLabel":"August 2026","publishedAt":"2026-09-01T09:00:00.000Z","publishedBy":"ana@example.com"},"review":[{"label":"Review","value":"Finalised by ana@example.com"}],"runHealth":[{"label":"Scheduled runs","value":"4 of 4 succeeded"}],"trend":[{"comparability":"permitted","label":"August 2026","month":"2026-08","score":"74"}]}"`
    );
  });
});

describe('the CSV rendering', () => {
  it('has the header, and a row per datum carrying the month and publication id', () => {
    const csv = monthCsv(monthDocument(identity(), content()));
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('month,publication_id,published_at,section,item,from_or_value,to,note');
    // Each section contributes at least its rows; the run-health row is the first datum.
    expect(lines[1]).toContain('2026-08,pub-1,2026-09-01T09:00:00.000Z,run health,Scheduled runs');
    expect(csv).toContain('finding delta');
    expect(csv).toContain('exception');
    expect(csv).toContain('trend');
    expect(csv).toContain('review,Review,Finalised by ana@example.com');
  });

  it('writes no review rows for a month this app held no review record for', () => {
    const csv = monthCsv(monthDocument(identity(), content({ review: [] })));
    expect(csv).not.toContain(',review,');
  });

  it('uses CRLF line endings, as the format specifies', () => {
    expect(monthCsv(monthDocument(identity(), content()))).toContain('\r\n');
  });

  it('defuses a cell a spreadsheet would evaluate', () => {
    // A label supplied from anywhere the estate can name is a formula position when it opens a cell;
    // the CSV helper prefixes it. The month document is built from resolved strings, but the guarantee
    // has to hold whatever those strings are.
    const csv = monthCsv(monthDocument(identity(), content({ runHealth: [{ label: '=cmd()', value: 'x' }] })));
    expect(csv).toContain("'=cmd()");
  });
});
