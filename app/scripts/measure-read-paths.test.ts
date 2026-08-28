import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  measure,
  populationFromReset,
  readsFromSource,
  type Population,
} from './measure-read-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESET = join(HERE, '..', 'server', 'admin', 'reset.ts');
const RECORDING = join(HERE, 'recordings', 'read-paths.json');

const population: Population = {
  scoped: ['notes', 'scans'],
  byParent: [{ table: 'improvement_actions', parent: 'improvement_plans' }],
};

describe('the population is RESET_TABLES, not a list restated here', () => {
  it('takes scoped and by-parent tables from the array, and no others', () => {
    const found = populationFromReset(`
      export const RESET_TABLES = [
        { table: 'notes', context: { kind: 'scoped', because: 'a note' } },
        { table: 'improvement_actions', context: { kind: 'by-parent', parent: 'improvement_plans', because: 'an action' } },
        { table: 'audit_events', context: { kind: 'installation-wide', because: 'the trail' } },
      ];
    `);
    expect(found.scoped).toEqual(['notes']);
    expect(found.byParent).toEqual([{ table: 'improvement_actions', parent: 'improvement_plans' }]);
  });

  it('does not treat a comment that names a table as a member of the array', () => {
    const found = populationFromReset(`
      export const RESET_TABLES = [
        // { table: 'ghost', context: { kind: 'scoped', because: 'not real' } },
        { table: 'notes', context: { kind: 'scoped', because: 'a note' } },
      ];
    `);
    expect(found.scoped).toEqual(['notes']);
    expect(found.scoped).not.toContain('ghost');
  });

  it('reads the committed RESET_TABLES rather than a fixture of it', () => {
    const found = populationFromReset(readFileSync(RESET, 'utf8'));
    expect(found.scoped).toContain('assessment_setup_drafts');
    expect(found.scoped).toContain('month_publications');
    expect(found.byParent.some((one) => one.table === 'improvement_actions')).toBe(true);
    expect(found.scoped).not.toContain('audit_events');
    expect(found.scoped).not.toContain('plan_extracts');
  });
});

describe('a comment is not a read', () => {
  it('ignores a select that sits only in a comment', () => {
    const reads = readsFromSource(
      `
        // select body from schema.notes where id = $1
        /* select subject_id from schema.notes */
        export const n = 1;
      `,
      'server/note/postgres-store.ts',
      population
    );
    expect(reads).toEqual([]);
  });

  it('still counts the select that the comment is talking about', () => {
    const reads = readsFromSource(
      `
        // The old query was: select body from schema.notes
        await db.query(\`select subject_id from \${db.schema}.notes where subject_kind = $1\`);
      `,
      'server/note/postgres-store.ts',
      population
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.table).toBe('notes');
  });
});

describe('the shape of a read follows the table it names', () => {
  it('classifies a scoped table as a predicate, even when the where does not yet mention definition_id', () => {
    const [read] = readsFromSource(
      `await db.query(\`select month from \${db.schema}.notes order by month desc\`);`,
      'server/monthly/store.ts',
      population
    );
    expect(read?.shape).toBe('predicate');
    expect(read?.alreadyFiltersDefinition).toBe(false);
  });

  it('records when a scoped read already names definition_id', () => {
    const [read] = readsFromSource(
      `await db.query(\`select body from \${db.schema}.notes where definition_id = $1\`);`,
      'server/note/postgres-store.ts',
      population
    );
    expect(read?.shape).toBe('predicate');
    expect(read?.alreadyFiltersDefinition).toBe(true);
  });

  it('classifies a by-parent table as a join', () => {
    const [read] = readsFromSource(
      `await db.query(\`select body from \${db.schema}.improvement_actions where id = $1\`);`,
      'server/improve/postgres-store.ts',
      population
    );
    expect(read?.shape).toBe('join');
    expect(read?.table).toBe('improvement_actions');
  });
});

describe('reads the apparatus cannot place are reported, not dropped', () => {
  it('keeps a select whose table is interpolated, and does not name the next keyword as the table', () => {
    const reads = readsFromSource(
      `await db.query(\`select count(*) as total from \${db.schema}.\${table} where \${stamp} < $1\`);`,
      'server/records/verify.ts',
      population
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.shape).toBe('unclassified');
    expect(reads[0]?.table).toBeNull();
    expect(reads[0]?.reason).toMatch(/dynamic table/i);
  });

  it('does not treat a selected column list as a missing table', () => {
    const [read] = readsFromSource(
      `
        const COLUMNS = 'id, definition_id, body';
        await db.query(\`select \${COLUMNS} from \${this.db.schema}.scans where id = $1\`);
      `,
      'server/scan/postgres-store.ts',
      { scoped: ['scans'], byParent: [] }
    );
    expect(read?.shape).toBe('predicate');
    expect(read?.table).toBe('scans');
  });

  it('does not treat selecting definition_id as filtering on it', () => {
    const [read] = readsFromSource(
      `await db.query(\`select author, definition_id, body from \${db.schema}.notes where author = $1\`);`,
      'server/define/setup-postgres-store.ts',
      { scoped: ['notes'], byParent: [] }
    );
    expect(read?.alreadyFiltersDefinition).toBe(false);
  });

  it('ignores a sentence that starts with SELECT but is not a query', () => {
    const reads = readsFromSource(
      `const requirement = \`SELECT on \${catalog}\`;`,
      'server/plan/descriptors.ts',
      population
    );
    expect(reads).toEqual([]);
  });

  it('does not invent a table for select 1', () => {
    const reads = readsFromSource(
      `await db.query('select 1');`,
      'server/scan/store-choice.ts',
      population
    );
    expect(reads).toEqual([]);
  });

  it('does not count an insert as a read', () => {
    const reads = readsFromSource(
      `await db.query(\`insert into \${db.schema}.notes (id) values ($1)\`);`,
      'server/note/postgres-store.ts',
      population
    );
    expect(reads).toEqual([]);
  });
});

describe('a select handed to a helper is still a read', () => {
  it('counts a template that is not the first argument of query()', () => {
    // accept/postgres-store.ts and apply/postgres-store.ts pass the SQL to a private `read` that
    // then calls query(text). A survey of `.query(` alone would see an identifier and miss the table.
    const reads = readsFromSource(
      `
        const rows = await this.read(
          operation,
          \`select body from \${this.options.db.schema}.notes where control_id = $1\`,
          [controlId]
        );
      `,
      'server/accept/postgres-store.ts',
      population
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.table).toBe('notes');
  });

  it('joins concatenated templates into one statement', () => {
    const reads = readsFromSource(
      `
        await db.query(
          \`select id, \${versioned ? 'revision, ' : ''}\${stored} as body from \${db.schema}.scans \` +
            \`order by started_at desc limit $1\`
        );
      `,
      'server/records/verify.ts',
      { scoped: ['scans'], byParent: [] }
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.table).toBe('scans');
  });
});

describe('the committed recording is what a fresh run of the apparatus produces', () => {
  it('matches measure() of the tree, so a read added without re-recording fails here', () => {
    const fresh = measure();
    const recorded = JSON.parse(readFileSync(RECORDING, 'utf8')) as ReturnType<typeof measure>;
    expect(fresh.totals).toEqual(recorded.totals);
    expect(fresh.reads).toEqual(recorded.reads);
    expect(fresh.population).toEqual(recorded.population);
  });
});
