// What the awaiting-reading gate refuses, and what it must not start refusing.
//
// The defect it exists for was one character, and the reason it survived was that a statement exempt
// from a measured duration turned out to be exempt from being read at all. So these hold the
// derivation rather than the two entries: that a parse failure is refused, that a text moving since
// its submission is refused, and that an unfamiliar error is not — a permission failure is a fact
// about the estate and a check that refused it would be deleted by the first person it blocked.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { STATEMENTS, UNPARSED, entries, faults, problems, shaOf } from './awaiting-reading.mjs';

const TEXT = 'SELECT 1\n';
const SHA = shaOf(TEXT);

function submitted(over: Record<string, unknown> = {}) {
  return {
    why: 'reads a schema labs does not have',
    owedBy: '65',
    submitted: {
      at: '2026-08-16T16:04:08.283Z',
      profile: 'labs',
      warehouseId: 'w',
      statementSha: SHA,
      sqlState: '42P01',
      error: '[TABLE_OR_VIEW_NOT_FOUND] The table or view cannot be found.',
      ...over,
    },
  };
}

describe('an entry with no submission', () => {
  it('is refused, because nothing has read the statement', () => {
    const found = faults({ why: 'a reason', owedBy: '65' }, TEXT);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('no recorded submission');
    expect(found[0]).toContain('record:awaiting');
  });

  it('is the only complaint, so the message is about the missing submission and not its fields', () => {
    expect(faults({}, TEXT)).toHaveLength(1);
  });
});

describe('what the recorded submission has to say', () => {
  it('accepts a resolution failure, which is what an absent system schema returns', () => {
    expect(faults(submitted(), TEXT)).toEqual([]);
  });

  it('refuses a syntax error, which is the platform not having read the statement at all', () => {
    const found = faults(submitted({ sqlState: '42601', error: "[PARSE_SYNTAX_ERROR] near 'latest'" }), TEXT);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('did not parse');
    expect(found[0]).toContain('PARSE_SYNTAX_ERROR');
  });

  it('accepts an error it has never seen, because refusing one would make the list unusable', () => {
    // A lapsed grant is a fact about the estate the statement was submitted against, not about the
    // statement. What the gate asks is whether the platform got past parsing, and this says it did.
    expect(faults(submitted({ sqlState: '42501', error: '[INSUFFICIENT_PERMISSIONS]' }), TEXT)).toEqual([]);
  });

  it('refuses a submission with no SQLSTATE, since that is the field the judgement is made on', () => {
    expect(faults(submitted({ sqlState: '' }), TEXT)[0]).toContain('no SQLSTATE');
  });

  it('refuses a submission with no usable date', () => {
    expect(faults(submitted({ at: 'the other day' }), TEXT)[0]).toContain('no usable date');
  });
});

describe('the digest', () => {
  it('refuses an entry whose statement has changed since it was submitted', () => {
    const found = faults(submitted(), 'SELECT 2\n');

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('changed since it was submitted');
  });

  it('moves for a comment, because a comment can hide the rest of a line from the parser', () => {
    expect(shaOf(`-- a note\n${TEXT}`)).not.toBe(SHA);
  });

  it('is over the file, and says so by refusing a statement whose file is not what the app sends', () => {
    // `queries.ts` expands `{{customer_catalog …}}`, and `labs.json` digests the expanded text. This
    // digests the file, which is the claim it can keep without a third copy of that expansion — so a
    // listed statement carrying a fragment is refused rather than digested wrongly.
    const found = faults(submitted({ statementSha: shaOf(`${TEXT}-- {{customer_catalog c}}\n`) }), `${TEXT}-- {{customer_catalog c}}\n`);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('fragment');
  });
});

describe('the list as it stands', () => {
  it('has a submission for every entry, against the statement in the tree', () => {
    expect(problems()).toEqual([]);
  });

  it('names only statements that exist, each with a submission that reached table resolution', () => {
    for (const [name, entry] of Object.entries(entries())) {
      const text = readFileSync(join(STATEMENTS, `${name}.sql`), 'utf8');

      expect(entry.submitted.statementSha).toBe(shaOf(text));
      expect(UNPARSED.has(entry.submitted.sqlState)).toBe(false);
    }
  });

  it('records the parameters it bound, so the submission is not a claim about a population', () => {
    for (const entry of Object.values(entries())) {
      expect(entry.submitted.parameters).toBeTypeOf('object');
    }
  });
});
