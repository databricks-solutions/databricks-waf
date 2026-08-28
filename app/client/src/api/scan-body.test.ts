// What the client asks a run to be, checked against what the server reads.
//
// This file exists because of the shape of the defect it guards, not because the function is hard.
// `/api/scan` has read `definitionId` since A2 and the client never sent one, so every run started
// from the interface was unstamped and account-wide — and both halves of the suite passed throughout.
// The server's tests post a `definitionId` and prove the route honours it. The client's prove the
// button starts a run. Neither asked whether the field the server reads is one the client sends.
//
// So these assertions are deliberately about the wire rather than about behaviour: the field names the
// route reads, and which of them are present.
//
// What is not tested here is an assessment sent alongside an override, which the route refuses as
// `assessment-and-overrides`. That pair is unconstructable through `ScanRequest` — it is a union, so
// naming a definition and a window is a compile error — and a test would have to cast past the type it
// is checking to reach the case. The choice worth recording is that `scanBody` does not repair such a
// body either: a serialiser that quietly dropped the overrides would turn a caller's slip into a run
// measuring something nobody asked for, where sending it earns a 400 that says "name one or the other".

import { describe, expect, it } from 'vitest';
import { scanBody, scanPath } from './hooks';

describe('the body a run is started with', () => {
  it('names the assessment, so the run can be stamped with it', () => {
    // The whole point of the row. Without this field the route resolves no definition, takes scope
    // from the calling identity's grants and stamps the run with nothing.
    expect(scanBody({ definitionId: 'def-1' })).toEqual({ definitionId: 'def-1' });
  });

  it('sends nothing at all for a run that names nothing', () => {
    // Not `{ definitionId: null }`. The route reads `!= null`, and an explicit null on any of the
    // three would be read as the field having been named.
    expect(scanBody({})).toEqual({});
  });

  it('carries a targeted rerun as pillars, without an assessment', () => {
    expect(scanBody({ pillars: ['cost-optimization'] })).toEqual({ pillars: ['cost-optimization'] });
  });

  it('carries a window on its own', () => {
    expect(scanBody({ lookbackDays: 90 })).toEqual({ lookbackDays: 90 });
  });

  it('carries selected workspaces without stamping the selected assessment', () => {
    expect(scanBody({ definitionId: null, workspaces: ['w2', 'w1'] })).toEqual({ workspaces: ['w2', 'w1'] });
  });

  it('sends only the fields it was given, in the names the route reads', () => {
    // The names matter as much as the values: `definitionId` is what the route looks for, and a body
    // that spelled it `definition` or `assessmentId` would be accepted, ignored, and produce exactly
    // the unstamped run this row exists to end.
    expect(Object.keys(scanBody({ definitionId: 'def-1' }))).toEqual(['definitionId']);
    expect(Object.keys(scanBody({ lookbackDays: 30, pillars: ['reliability'], workspaces: ['w1'] }))).toEqual([
      'lookbackDays',
      'pillars',
      'workspaces',
    ]);
  });
});

describe('the assessment context a run is started in', () => {
  it('keeps the selected assessment for a targeted pillar rerun', () => {
    expect(scanPath({ pillars: ['reliability'] }, 'definition-1')).toBe('/api/scan?definitionId=definition-1');
  });

  it('drops the selected assessment for confirmed custom scope', () => {
    expect(scanPath({ definitionId: null, workspaces: ['w1'] }, 'definition-1')).toBe('/api/scan');
  });

  it('sends a saved assessment in the body without duplicating it in the query', () => {
    expect(scanPath({ definitionId: 'definition-2' }, 'definition-1')).toBe('/api/scan');
  });
});
