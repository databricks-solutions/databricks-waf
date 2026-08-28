// The primitives, asserted on the HTML they emit.
//
// Three of the design system's rules are properties of the markup rather than of the types, so
// they compile clean while being wrong: a status carried by colour alone, an empty region that
// says nothing about which kind of empty it is, and a numeric column that does not line up.
// Each is checked here on the rendered output, with the server renderer so no DOM is needed.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataTable } from './DataTable';
import { EmptyState, type EmptyReason } from './EmptyState';
import { SCORE_DISCLAIMER, ScoreDisclaimer, ScoreDisclaimerMark } from './ScoreDisclaimer';
import { OutcomeBadge, SeverityBadge } from './StatusBadge';
import type { Outcome, Severity } from '@/api/types';

const html = (element: React.JSX.Element): string => renderToStaticMarkup(element);

const OUTCOMES: readonly Outcome[] = [
  'pass',
  'fail',
  'partial',
  'unmeasurable',
  'not-applicable',
  'satisfied-by-architecture',
];

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'informational'];

const REASONS: readonly EmptyReason[] = [
  'not-yet-collected',
  'nothing-to-report',
  'no-evidence',
  'filtered-out',
  'collector-failed',
  'permission-required',
  'not-applicable',
];

describe('the outcome badge', () => {
  it('carries a shape as well as a word for every outcome', () => {
    for (const outcome of OUTCOMES) {
      const markup = html(<OutcomeBadge outcome={outcome} />);
      // An svg, because colour alone fails a colour-blind reader and a word alone gives a
      // dense list nothing to resolve peripherally.
      expect(markup, outcome).toContain('<svg');
      expect(markup, outcome).toMatch(/>[A-Z]/);
    }
  });

  it('gives the two success outcomes different shapes', () => {
    // Met and met-by-architecture are both green. If they also shared an icon, the
    // distinction would exist only in text a reader skimming a column never reads.
    expect(html(<OutcomeBadge outcome="pass" />)).not.toEqual(
      html(<OutcomeBadge outcome="satisfied-by-architecture" />)
    );
  });

  it('leaves unmeasured and not-applicable uncoloured', () => {
    // Neither is a finding about the estate. Tinting them teaches people to read the tool's
    // own blind spots, and its exclusions, as problems they have to answer for.
    for (const outcome of ['unmeasurable', 'not-applicable'] as const) {
      const markup = html(<OutcomeBadge outcome={outcome} />);
      expect(markup, outcome).not.toContain('wa-badge-danger');
      expect(markup, outcome).not.toContain('wa-badge-warning');
      expect(markup, outcome).not.toContain('wa-badge-success');
    }
  });
});

describe('the severity badge', () => {
  it('spends colour only on critical and high', () => {
    expect(html(<SeverityBadge severity="critical" />)).toContain('wa-badge-danger');
    expect(html(<SeverityBadge severity="high" />)).toContain('wa-badge-warning');

    for (const severity of ['medium', 'low', 'informational'] as const) {
      const markup = html(<SeverityBadge severity={severity} />);
      expect(markup, severity).not.toContain('wa-badge-danger');
      expect(markup, severity).not.toContain('wa-badge-warning');
    }
  });

  it('names every severity', () => {
    for (const severity of SEVERITIES) {
      expect(html(<SeverityBadge severity={severity} />), severity).toMatch(/>[A-Z]/);
    }
  });
});

describe('the empty state', () => {
  it('records which of the reasons it is, for every reason', () => {
    for (const reason of REASONS) {
      const markup = html(<EmptyState reason={reason} detail="Because of a specific thing." />);
      // Attributed in the markup as well as worded, so a test or a screenshot review can tell
      // a clean result from a failed collector without reading the prose.
      expect(markup, reason).toContain(`data-empty-reason="${reason}"`);
      expect(markup, reason).toContain('Because of a specific thing.');
    }
  });

  it('marks only the genuinely clean case as positive', () => {
    expect(html(<EmptyState reason="nothing-to-report" detail="No requirement failed." />)).toContain(
      'text-wa-success'
    );
    // Nothing collected yet is not good news; it is an unanswered question.
    expect(html(<EmptyState reason="not-yet-collected" detail="Run a scan." />)).not.toContain('text-wa-success');
    expect(html(<EmptyState reason="collector-failed" detail="The warehouse refused." />)).not.toContain(
      'text-wa-success'
    );
  });

  it('is announced, since an empty result is the whole content of its region', () => {
    expect(html(<EmptyState reason="filtered-out" detail="Widen the filters." />)).toContain('role="status"');
  });
});

describe('the data table', () => {
  interface Round {
    readonly id: string;
    readonly score: number;
  }

  const columns = [
    { key: 'id', header: 'Scan', cell: (row: Round) => row.id },
    { key: 'score', header: 'Score', numeric: true, cell: (row: Round) => row.score.toFixed(1) },
  ];

  it('right-aligns numeric columns with tabular figures, header and cell alike', () => {
    const markup = html(
      <DataTable
        caption="Scans"
        columns={columns}
        rows={[{ id: 'a', score: 9.5 }]}
        rowKey={(row) => row.id}
        empty={{ reason: 'nothing-to-report', detail: 'None.' }}
      />
    );

    expect(markup).toContain('tabular-nums');
    // Header alignment matters as much as the cells': a left-aligned header over a
    // right-aligned column reads as a misalignment bug in the data.
    expect(markup.match(/text-right/g)?.length).toBe(2);
  });

  it('states what the table is, for a reader who cannot see its position on the page', () => {
    const markup = html(
      <DataTable
        caption="Previous scans, newest first"
        columns={columns}
        rows={[{ id: 'a', score: 1 }]}
        rowKey={(row) => row.id}
        empty={{ reason: 'nothing-to-report', detail: 'None.' }}
      />
    );

    expect(markup).toContain('Previous scans, newest first');
  });

  it('carries each column label into the responsive record treatment', () => {
    const markup = html(
      <DataTable
        caption="Scans"
        columns={columns}
        rows={[{ id: 'a', score: 9.5 }]}
        rowKey={(row) => row.id}
        empty={{ reason: 'nothing-to-report', detail: 'None.' }}
      />
    );

    expect(markup).toContain('data-responsive-records="true"');
    expect(markup).toContain('data-label="Scan"');
    expect(markup).toContain('data-label="Score"');
  });

  it('shows the reason rather than an empty table when there are no rows', () => {
    const markup = html(
      <DataTable
        caption="Scans"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        empty={{ reason: 'not-yet-collected', detail: 'Run a scan.' }}
      />
    );

    // A headed table with no body is the pattern that leaves a reader unsure whether the
    // query was empty or the request failed.
    expect(markup).not.toContain('<table');
    expect(markup).toContain('data-empty-reason="not-yet-collected"');
  });
});

describe('the score disclaimer', () => {
  it("says the score is this application's, not Databricks'", () => {
    expect(SCORE_DISCLAIMER).toContain('not an official Databricks score');
    expect(html(<ScoreDisclaimer />)).toContain('not an official Databricks score');
  });

  it('reaches assistive technology even in the compact form, where a title alone would not', () => {
    const markup = html(<ScoreDisclaimerMark />);
    // The visible mark is short; the sentence must still be readable without a pointer, so it
    // appears in the accessibility tree rather than only in a tooltip.
    expect(markup).toContain('sr-only');
    expect(markup).toContain('not an official Databricks score');
  });
});
