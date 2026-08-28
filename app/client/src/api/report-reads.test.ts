import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPerControlCollection, REPORT_COLLECTION_READS } from './report-reads';

const here = dirname(fileURLToPath(import.meta.url));

describe('the report collection reads', () => {
  it('are two paths that do not name a control, so the count cannot grow with the catalogue', () => {
    expect(isPerControlCollection(REPORT_COLLECTION_READS.raised)).toBe(false);
    expect(isPerControlCollection(REPORT_COLLECTION_READS.notes)).toBe(false);
    expect(isPerControlCollection('/api/improvements/for/CO-01-01')).toBe(true);
    expect(isPerControlCollection('/api/notes/control/CO-01-01')).toBe(true);
    expect(isPerControlCollection('/api/notes/threads/control')).toBe(false);
  });

  it('are what the report asks for, and a printed finding does not ask per control', () => {
    const report = readFileSync(join(here, '../pages/ReportPage.tsx'), 'utf8');
    const detail = readFileSync(join(here, '../components/FindingDetail.tsx'), 'utf8');

    expect(report).toContain('useRaisedActions');
    expect(report).toContain('useNoteThreads');
    expect(report).not.toMatch(/improvements\/for\//);
    expect(report).not.toMatch(/notes\/control\//);
    expect(detail).toContain('printed ? { actions:');
    expect(detail).toContain('printed ? { notes:');
  });
});
