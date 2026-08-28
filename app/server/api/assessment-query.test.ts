import { describe, expect, it } from 'vitest';
import { assessmentOf, scopedHref } from './assessment-query.js';
import type { Request } from 'express';

function request(query: Request['query']): Request {
  return { query } as Request;
}

describe('assessmentOf', () => {
  it('reads a named definition from the query string', () => {
    expect(assessmentOf(request({ definitionId: 'def-1' }))).toBe('def-1');
  });

  it('treats an omitted or empty parameter as the unscoped view, not every assessment', () => {
    expect(assessmentOf(request({}))).toBeNull();
    expect(assessmentOf(request({ definitionId: '' }))).toBeNull();
    expect(assessmentOf(request({ definitionId: '  ' }))).toBeNull();
  });

  it('refuses a repeated key rather than picking one, because Express would hand an array', () => {
    expect(assessmentOf(request({ definitionId: ['def-1', 'def-2'] }))).toBeNull();
  });
});

describe('scopedHref', () => {
  it('appends the assessment, including after an existing query', () => {
    expect(scopedHref('/api/scans/s1/export.csv', 'def-1')).toBe('/api/scans/s1/export.csv?definitionId=def-1');
    expect(scopedHref('/api/scans/s1/export.csv?variant=executive', 'def-1')).toBe(
      '/api/scans/s1/export.csv?variant=executive&definitionId=def-1'
    );
  });

  it('leaves an unscoped record as an unscoped URL', () => {
    expect(scopedHref('/api/scans/s1/export.csv', null)).toBe('/api/scans/s1/export.csv');
    expect(scopedHref('/api/scans/s1/export.csv', undefined)).toBe('/api/scans/s1/export.csv');
    expect(scopedHref('/api/scans/s1/export.csv', '')).toBe('/api/scans/s1/export.csv');
  });
});
