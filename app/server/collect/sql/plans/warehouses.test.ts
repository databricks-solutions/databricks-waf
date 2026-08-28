import { describe, expect, it, vi } from 'vitest';
import { localWarehouseIds } from './warehouses.js';
import type { WorkspaceClientFactory } from '../../rest/client.js';

/** A client whose `warehouses.list` yields what a test names, as the SDK's async iterable does. */
function listing(...pages: readonly (readonly { id?: string }[])[]): {
  readonly client: WorkspaceClientFactory;
  readonly list: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn().mockImplementation(function* () {
    for (const page of pages) for (const warehouse of page) yield warehouse;
  });
  return { client: () => Promise.resolve({ warehouses: { list } } as never), list };
}

describe('localWarehouseIds', () => {
  it('collects every id the workspace lists', async () => {
    const { client } = listing([{ id: 'wh-1' }, { id: 'wh-2' }]);
    expect(await localWarehouseIds(client)).toEqual(new Set(['wh-1', 'wh-2']));
  });

  it('reads through the SDK pagination rather than one page of it', async () => {
    const { client } = listing([{ id: 'wh-1' }], [{ id: 'wh-2' }], [{ id: 'wh-3' }]);
    expect(await localWarehouseIds(client)).toEqual(new Set(['wh-1', 'wh-2', 'wh-3']));
  });

  it('drops a warehouse with no usable id rather than putting an empty string in the set', async () => {
    // An empty string in the set would make `skipReason` match a shape whose warehouse id is also
    // empty, which is the one case it is meant to catch with `no-warehouse-id`.
    const { client } = listing([{ id: 'wh-1' }, {}, { id: '' }]);
    expect(await localWarehouseIds(client)).toEqual(new Set(['wh-1']));
  });

  it('answers an empty set for a workspace that genuinely has none', async () => {
    const { client } = listing([]);
    expect(await localWarehouseIds(client)).toEqual(new Set());
  });

  it('throws when the list is refused, rather than passing off a refusal as an empty estate', async () => {
    const client: WorkspaceClientFactory = () =>
      Promise.resolve({
        warehouses: {
          // eslint-disable-next-line require-yield
          list: function* () {
            throw Object.assign(new Error('permission denied'), { status: 403 });
          },
        },
      } as never);

    await expect(localWarehouseIds(client)).rejects.toThrow('permission denied');
  });
});
