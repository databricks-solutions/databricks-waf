import { describe, expect, it } from 'vitest';
import { csv } from './csv.js';

describe('a CSV document', () => {
  it('separates fields with commas and rows with CRLF', () => {
    expect(csv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d');
  });

  it('quotes a field containing a comma, so one value does not become two columns', () => {
    expect(csv([['jobs, clusters and warehouses']])).toBe('"jobs, clusters and warehouses"');
  });

  it('doubles quotes inside a quoted field', () => {
    expect(csv([['the "default" policy, unchanged']])).toBe('"the ""default"" policy, unchanged"');
  });

  it('quotes a field containing a newline, which an error message from a workspace often does', () => {
    expect(csv([['PERMISSION_DENIED\nat line 4']])).toBe('"PERMISSION_DENIED\nat line 4"');
  });

  it('leaves an ordinary field alone rather than quoting everything', () => {
    // Not cosmetic. A file where every cell is quoted is a file where a reader cannot see at a
    // glance which cells contain something unusual.
    expect(csv([['SEC-01-02', 'fail', 'high']])).toBe('SEC-01-02,fail,high');
  });
});

describe('a field a spreadsheet would execute', () => {
  // The values here are what a customer's own estate can put into this file: a table name, a
  // catalogue name, the text of a permission error. None of it is trusted input.

  it('defuses a formula, so naming a table cannot run a program on the reader’s laptop', () => {
    expect(csv([["=cmd|'/C calc'!A0"]])).toBe("'=cmd|'/C calc'!A0");
  });

  it('defuses the same payload written to start with a minus', () => {
    // The classic bypass: a leading minus reaches the same evaluator as a leading equals.
    expect(csv([["-1+1+cmd|'/C calc'!A0"]])).toBe("'-1+1+cmd|'/C calc'!A0");
  });

  it('defuses the at and plus forms', () => {
    expect(csv([['@SUM(A1)']])).toBe("'@SUM(A1)");
    expect(csv([['+SUM(A1)']])).toBe("'+SUM(A1)");
  });

  it('defuses a payload hidden behind a tab, which paste strips', () => {
    expect(csv([['\t=SUM(A1)']])).toBe("'\t=SUM(A1)");
  });

  it('leaves a negative number as a number, so a column of figures still adds up', () => {
    // The reason the rule tests for a number rather than for a leading minus. A reader who
    // exported to sum a column and found text in it would have to fix every cell by hand.
    expect(csv([['-3']])).toBe('-3');
    expect(csv([['-12.5']])).toBe('-12.5');
    expect(csv([['+0.5']])).toBe('+0.5');
    expect(csv([['-1.2e-4']])).toBe('-1.2e-4');
  });

  it('defuses something that starts like a number and does not stay one', () => {
    expect(csv([["-3-cmd|'/C calc'!A0"]])).toBe("'-3-cmd|'/C calc'!A0");
  });

  it('quotes as well as defuses, when the payload also carries a comma', () => {
    // Both rules on one value, which is the realistic case: a formula argument list has commas.
    expect(csv([['=SUM(A1,B2)']])).toBe('"\'=SUM(A1,B2)"');
  });

  it('defuses every line of a multi-line cell, not only the first', () => {
    // The hole this closed. RFC 4180 lets a quoted field hold newlines and the plan export uses that —
    // an action's steps are one cell of several lines, because any separator would be one a step could
    // contain. Anchoring the rule to the whole cell left every line after the first undefended, and it
    // is reachable by the mechanism this file already reasons about for tab: a reader who copies the
    // cell out of the sheet gets one row per line, and each line lands in a formula position.
    expect(csv([['Write the policy\n=cmd|calc']])).toBe('"Write the policy\n\'=cmd|calc"');
  });

  it('leaves an inner line that is a plain number alone, on the same terms as a first line', () => {
    // The numeric exemption has to apply per line too, or a cell of figures becomes a cell of text.
    expect(csv([['Costs\n-3']])).toBe('"Costs\n-3"');
  });
});
