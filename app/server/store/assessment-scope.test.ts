import { describe, expect, it } from 'vitest';
import { applyScope, inScope, stamped } from './assessment-scope.js';

describe('applyScope', () => {
  it('leaves the fragment alone when the read is installation-wide', () => {
    expect(applyScope('where id = $1', ['abc'], undefined)).toEqual({
      fragment: 'where id = $1',
      values: ['abc'],
    });
  });

  it('binds the next placeholder when the read names a definition', () => {
    expect(applyScope('where control_id = $1', ['OE-02-04'], 'def-1')).toEqual({
      fragment: 'where control_id = $1 and definition_id = $2',
      values: ['OE-02-04', 'def-1'],
    });
  });

  it('uses is-null rather than a placeholder when the read is of unscoped records', () => {
    expect(applyScope('where id = $1', ['abc'], null)).toEqual({
      fragment: 'where id = $1 and definition_id is null',
      values: ['abc'],
    });
  });

  it('inserts the predicate before order by, so a month list still orders', () => {
    expect(applyScope('where month = $1 order by published_at asc', ['2026-08'], 'def-1')).toEqual({
      fragment: 'where month = $1 and definition_id = $2 order by published_at asc',
      values: ['2026-08', 'def-1'],
    });
  });

  it('becomes the whole where when the fragment was empty', () => {
    expect(applyScope('', [], 'def-1')).toEqual({
      fragment: 'where definition_id = $1',
      values: ['def-1'],
    });
  });

  it('becomes the whole where when the fragment was only an order by', () => {
    expect(applyScope('order by revision asc', [], null)).toEqual({
      fragment: 'where definition_id is null order by revision asc',
      values: [],
    });
  });
});

describe('inScope', () => {
  it('accepts every row when the read is installation-wide', () => {
    expect(inScope('def-1', undefined)).toBe(true);
    expect(inScope(null, undefined)).toBe(true);
  });

  it('matches a named definition and nothing else', () => {
    expect(inScope('def-1', 'def-1')).toBe(true);
    expect(inScope('def-2', 'def-1')).toBe(false);
    expect(inScope(null, 'def-1')).toBe(false);
    expect(inScope('', 'def-1')).toBe(false);
  });

  it('treats null and the empty string as unscoped, because drafts spell none that way', () => {
    expect(inScope(null, null)).toBe(true);
    expect(inScope(undefined, null)).toBe(true);
    expect(inScope('', null)).toBe(true);
    expect(inScope('def-1', null)).toBe(false);
  });
});

describe('stamped', () => {
  it('names the definition when the write is under one', () => {
    expect(stamped({ id: 'a' }, 'def-1')).toEqual({ id: 'a', definitionId: 'def-1' });
  });

  it('leaves the record unnamed when the write is unscoped', () => {
    expect(stamped({ id: 'a' }, null)).toEqual({ id: 'a' });
  });
});
