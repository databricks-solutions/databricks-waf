// The words in front of the two irreversible acts.
//
// Worth testing as prose rather than as data because prose is what the reader acts on. A sentence that
// undercounts, or that reassures where it should not, is the same defect as a button wired to the wrong
// route: the reader presses it having understood something that was not true.

import { describe, expect, it } from 'vitest';
import type { Reset, ResetPlan } from '../api/types';
import { resetSentence, resetWarning } from './retention-language';

function plan(over: Partial<ResetPlan> = {}): ResetPlan {
  return {
    tables: [
      { table: 'scans', holds: 'Collected readings', rows: 40, swept: true },
      { table: 'definitions', holds: 'What this install assesses against', rows: 2, swept: false },
    ],
    records: 42,
    events: 9,
    heldBy: [],
    ...over,
  };
}

describe('what deleting assessment data would remove', () => {
  it('names the count, the tables and that nothing recovers it', () => {
    const said = resetWarning(plan());

    expect(said).toContain('42 records');
    expect(said).toContain('2 tables');
    expect(said).toContain('cannot be undone');
  });

  /*
   * The definitions specifically. They are the one thing on this page a reader has been told twice is
   * never removed — the exempt note under the periods says so, and it is true of every period. A reset
   * takes them, and a sentence that left that implicit would be technically complete and practically a
   * trap.
   */
  it('says the definitions go, having told the reader twice that periods never touch them', () => {
    expect(resetWarning(plan())).toContain('definitions');
  });

  it('counts the trail separately, because its size is not something the reader chose', () => {
    const said = resetWarning(plan());

    expect(said).toContain('9 events');
    expect(said).toContain('single event');
  });

  it('says nothing about the trail on an install that has not recorded anything yet', () => {
    expect(resetWarning(plan({ events: 0 }))).not.toContain('audit trail');
  });

  /*
   * A hold outranks the count. Told the number first, a reader goes and reads the number again; told the
   * hold first, they go and read the hold — which is the thing standing in their way and the only thing
   * they can act on.
   */
  it('leads with the hold rather than the count, since the hold is what can be acted on', () => {
    const said = resetWarning(plan({ heldBy: ['hold-1'] }));

    expect(said).toContain('legal hold');
    expect(said).toContain('does not override');
    expect(said).not.toContain('42');
  });

  it('says lift them of more than one hold, since a reader lifts each separately', () => {
    const said = resetWarning(plan({ heldBy: ['hold-1', 'hold-2'] }));

    expect(said).toContain('2 legal holds are in force');
    expect(said).toContain('Lift them below if they no longer apply');
  });

  it('says there is no assessment data rather than offering to delete nothing', () => {
    expect(resetWarning(plan({ records: 0, events: 0, tables: [] }))).toContain('no assessment data to delete');
  });

  /*
   * Records at zero with a trail above it is the ordinary state of a fresh install somebody has been
   * clicking around, and the reset there is not a no-op: the trail goes. The sentence has to still
   * describe an act.
   */
  it('still describes an act where only the trail has anything in it', () => {
    const said = resetWarning(plan({ records: 0 }));

    expect(said).toContain('no records yet');
    expect(said).toContain('9 events');
    // Not "0 records across 16 tables", which is a sentence about nothing in front of a button that
    // empties the trail.
    expect(said).not.toContain('0 records');
  });
});

describe('what a reset did', () => {
  function did(over: Partial<Reset> = {}): Reset {
    return {
      at: '2026-08-04T00:00:00.000Z',
      by: 'priya@example.com',
      emptied: [{ table: 'scans', removed: 40 }],
      rows: 51,
      tables: 3,
      ...over,
    };
  }

  it('says what went, and that the trail now starts from the act itself', () => {
    const said = resetSentence(did());

    expect(said).toContain('51 rows');
    expect(said).toContain('3 tables');
    expect(said).toContain('first event of a new chain');
  });

  it('is a date rather than an ISO stamp, as every other date on the page is', () => {
    expect(resetSentence(did())).not.toContain('T00:00');
  });

  it('records an install with no assessment data without claiming a removal', () => {
    const said = resetSentence(did({ rows: 0, tables: 0, emptied: [] }));

    expect(said).toContain('already held no assessment data');
    expect(said).toContain('priya@example.com');
  });

  it('counts one row and one table in the singular', () => {
    expect(resetSentence(did({ rows: 1, tables: 1 }))).toContain('1 row removed from 1 table');
  });
});
