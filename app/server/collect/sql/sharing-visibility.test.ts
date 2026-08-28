// The two readings that decide whether a sharing count of zero is an estate or a permission, held
// to their shape at both ends: what the statement asks the metastore for, and what the parser makes
// of the answer.
//
// Worth its own file because the two ends are coupled by a string and nothing else. The resolvers
// test `USE_SHARE` against `PlatformCensus.sharingPrivileges`; the statement decides which privilege
// names ever reach that field. Narrow the statement's IN list and every resolver test still passes
// while every count reads as unseen — the failure would be silent, estate-wide, and in the direction
// of withdrawing requirements from the score.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parse } from './shapes.js';

const CENSUS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../config/statements/uc_platform_census.sql'),
  'utf8'
);

/**
 * The aliases the statement's final SELECT produces — its output columns, in order.
 *
 * Comment lines go first, because the header prose contains the word `as` in sentences and an earlier
 * version of this collected `the` and `c` from them. The CTEs go next: everything up to the last
 * top-level `SELECT` is the `WITH` block, whose aliases are internal names no parser sees. What is left
 * is the projection, one alias per line, each ending the line or ending it with a comma.
 *
 * The trailing `FROM` is cut for the same reason the comments are: `FROM ... AS c` aliases a relation,
 * not a column, and it arrived in this list as a nineteenth output the parser was then asked about.
 */
function outputAliases(statement: string): readonly string[] {
  const code = statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const afterCtes = code.slice(code.lastIndexOf('\nSELECT\n'));
  const from = /\nFROM /.exec(afterCtes);
  const projection = from == null ? afterCtes : afterCtes.slice(0, from.index);
  return [...projection.matchAll(/\bAS ([a-z_][a-z0-9_]*),?[ \t]*$/gim)].map((match) => match[1]);
}

/** One row of the census, with only the fields a test names; the parser reads the rest as zero. */
function row(fields: Readonly<Record<string, string | null>>): readonly Record<string, string | null>[] {
  return [fields];
}

describe('what the census returns, against what the parser reads', () => {
  // Every field `parse.platformCensus` reads, with the alias it reads it under. The parser defaults a
  // column it cannot find to zero, the empty string or false, so an alias that stops being returned
  // reads as a metastore with none of that thing rather than as a statement that lost a column.
  //
  // This exists because Q1k restructured the statement: three relations that were read by two scalar
  // subqueries each are now read once into a CTE, and the two counts come off the CTE. Six aliases
  // moved. Nothing else in the suite would have failed if one of them had been dropped on the way —
  // the resolver tests build their own rows, and `parse` is happy with a row that is missing anything.
  const READ_BY_PARSER = [
    'shares',
    'recipients',
    'token_recipients',
    'recipients_with_ip_allowlist',
    'providers',
    'connections',
    'connection_types',
    'external_locations',
    'storage_credentials',
    'volumes',
    'managed_volumes',
    'routines',
    'column_masks',
    'row_filters',
    'tagged_tables',
    'tagged_columns',
    'owns_metastore',
    'sharing_privileges',
  ] as const;

  it('returns every column the parser reads', () => {
    for (const column of READ_BY_PARSER) expect(outputAliases(CENSUS)).toContain(column);
  });

  it('reads nothing the census does not return, so a parser field is not permanently zero', () => {
    // The other direction. A field read under a name the statement never produced is a control scored
    // against a constant, and the parser cannot tell that from a genuine zero.
    const aliased = new Set(outputAliases(CENSUS));
    const parser = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'shapes.ts'), 'utf8');
    const body = /platformCensus: \(rows: readonly Row\[\]\): PlatformCensus => \{([\s\S]*?)\n {2}\},/.exec(parser)?.[1];
    expect(body).toBeDefined();
    const readNames = [...(body ?? '').matchAll(/\b(?:count|text|bool)\(row, '([a-z_][a-z0-9_]*)'\)/g)].map(
      (match) => match[1]
    );
    expect(readNames.length).toBe(READ_BY_PARSER.length);
    for (const name of readNames) expect(aliased).toContain(name);
  });
});

describe('what the census asks about its own visibility', () => {
  it('names the four privileges the resolvers test for', () => {
    const list = /privilege_type IN \(\s*([\s\S]*?)\s*\)/.exec(CENSUS)?.[1];
    expect(list).toBeDefined();
    const named = (list ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^'|'$/g, ''))
      .sort();
    expect(named).toEqual(['USE_CONNECTION', 'USE_PROVIDER', 'USE_RECIPIENT', 'USE_SHARE']);
  });

  it('expands group grants and group ownership, not only the identity itself', () => {
    // Both halves, because the metastore admin is a role Databricks recommends assigning to a group,
    // and a grant to `account users` is how the labs reading was verified.
    expect(CENSUS).toContain('is_account_group_member(grantee)');
    expect(CENSUS).toContain('is_account_group_member(metastore_owner)');
  });
});

describe('what the parser makes of the answer', () => {
  it('reads the privileges the statement joined into one field', () => {
    const census = parse.platformCensus(row({ owns_metastore: 'false', sharing_privileges: 'USE_PROVIDER,USE_SHARE' }));
    expect(census.ownsMetastore).toBe(false);
    expect(census.sharingPrivileges).toEqual(['USE_PROVIDER', 'USE_SHARE']);
  });

  it('reads no privileges from the empty string the statement returns over no rows', () => {
    // `array_join(collect_set(...))` over nothing is `''`, not null, and `''.split(',')` is `['']` —
    // one privilege named by the empty string, which would match nothing and read as unseen anyway,
    // but only by luck.
    const census = parse.platformCensus(row({ owns_metastore: 'true', sharing_privileges: '' }));
    expect(census.sharingPrivileges).toEqual([]);
  });

  it('treats a reading it did not get as visibility not established, rather than as ownership', () => {
    // The safe direction: an absent `owns_metastore` must not let a filtered zero through as an
    // estate. A scan that could not read this column knows less than one that read `false`, not more.
    const census = parse.platformCensus(row({}));
    expect(census.ownsMetastore).toBe(false);
    expect(census.sharingPrivileges).toEqual([]);
  });
});
