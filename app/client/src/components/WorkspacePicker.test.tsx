// What the picker must not lose, and what it must not offer.
//
// The assembly is tested directly rather than through a rendered list. Everything interesting here
// is the decision about which rows exist and which of them can be ticked; driving that through a
// checkbox would put React's event handling between the assertion and the behaviour, and the
// behaviour is what regresses.

import { describe, expect, it } from 'vitest';
import type { SelectableWorkspace } from '@/api/types';
import { describeSelection, rowsFor } from './WorkspacePicker';

function workspace(over: Partial<SelectableWorkspace> & { id: string }): SelectableWorkspace {
  return { name: `Workspace ${over.id}`, status: 'RUNNING', assessable: true, ...over };
}

const DIRECTORY: readonly SelectableWorkspace[] = [
  workspace({ id: 'w1', name: 'Analytics' }),
  workspace({ id: 'w9', name: 'Retired', status: 'BANNED', assessable: false, reason: 'not-running' }),
  workspace({ id: 'w8', name: 'Elsewhere', assessable: false, reason: 'other-region' }),
];

describe('the rows a picker offers', () => {
  it('lists what cannot be covered rather than leaving it out', () => {
    const rows = rowsFor(DIRECTORY, []);

    // All three, because a workspace absent from the list cannot be told from one nobody scrolled to.
    expect(rows.map((row) => row.id)).toEqual(['w1', 'w9', 'w8']);
    expect(rows.map((row) => row.selectable)).toEqual([true, false, false]);
  });

  /*
   * The row a status alone cannot explain. This workspace is RUNNING and still not something this
   * deployment can read, so offering it as selectable would promise an assessment it cannot deliver.
   */
  it('refuses a running workspace in another region, and keeps its reason', () => {
    const elsewhere = rowsFor(DIRECTORY, []).find((row) => row.id === 'w8');

    expect(elsewhere?.status).toBe('RUNNING');
    expect(elsewhere?.selectable).toBe(false);
    expect(elsewhere?.kind).toBe('other-region');
  });

  /*
   * The defect a picker built from the directory alone has, and the reason it is worth a test of its
   * own: it is silent. An author opens a definition written in June, changes something unrelated,
   * saves, and the workspaces cancelled in July have left the scope without anybody choosing that.
   */
  it('keeps a selected workspace the directory has no row for', () => {
    const rows = rowsFor(DIRECTORY, ['w1', 'gone']);

    const orphan = rows.find((row) => row.id === 'gone');
    expect(orphan).toBeDefined();
    expect(orphan?.kind).toBe('unknown');
    // Its id is the only name available, since a name would have come from the directory.
    expect(orphan?.name).toBe('gone');
  });

  /*
   * And it has to be removable. A row that warns the author about a workspace they cannot deselect
   * would leave them unable to correct the very thing it is warning them about.
   */
  it('lets the author remove a workspace it cannot account for', () => {
    const orphan = rowsFor(DIRECTORY, ['gone']).find((row) => row.id === 'gone');

    expect(orphan?.selectable).toBe(true);
  });

  it('adds no row for a selected workspace the directory does account for', () => {
    const rows = rowsFor(DIRECTORY, ['w1', 'w8', 'w9']);

    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.kind === 'unknown')).toEqual([]);
  });

  it('marks a workspace with no reason as one it cannot account for, rather than as assessable', () => {
    // A directory row that says not assessable and does not say why. The route does not produce this
    // today; treating it as selectable if one ever arrived would be the wrong way to be wrong.
    const rows = rowsFor([workspace({ id: 'w7', assessable: false })], []);

    expect(rows[0]?.kind).toBe('unknown');
    expect(rows[0]?.selectable).toBe(false);
  });

  it('offers nothing when the directory is empty and nothing was selected', () => {
    expect(rowsFor([], [])).toEqual([]);
  });

  /*
   * An empty directory with a selection is the state after a scan that could not read the estate.
   * The selection has to survive it: dropping the rows would mean an unreadable directory silently
   * emptied somebody's scope.
   */
  it('still lists the selection when the directory could not be read', () => {
    const rows = rowsFor([], ['w1', 'w2']);

    expect(rows.map((row) => row.id)).toEqual(['w1', 'w2']);
    expect(rows.every((row) => row.kind === 'unknown')).toBe(true);
  });
});

describe('what the picker says the selection amounts to', () => {
  it('counts the assessable ones chosen, not every id in scope', () => {
    // One assessable and two that cannot be read. Counting all three against the one assessable row
    // gave "3 of 1", which is both impossible and a claim the run would cover three workspaces.
    const selected = ['w1', 'w8', 'w9'];
    const said = describeSelection(rowsFor(DIRECTORY, selected), selected);

    expect(said).toContain('1 of 1 assessable workspace selected');
    expect(said).toContain('2 others are in scope but cannot be read');
    expect(said, 'no impossible fraction').not.toMatch(/3 of 1/u);
  });

  it('says so plainly when nothing in scope can be read at all', () => {
    const said = describeSelection(rowsFor([], ['gone']), ['gone']);

    expect(said).toContain('None of the assessable workspaces are selected.');
    expect(said).toContain('1 other is in scope but cannot be read');
  });

  it('says nothing about unreadable workspaces when there are none', () => {
    const said = describeSelection(rowsFor(DIRECTORY, ['w1']), ['w1']);

    expect(said).toBe('1 of 1 assessable workspace selected.');
  });

  it('points at the alternative when nothing is selected', () => {
    expect(describeSelection(rowsFor(DIRECTORY, []), [])).toContain('whole account');
  });
});
