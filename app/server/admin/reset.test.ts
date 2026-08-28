// Emptying an install.
//
// Four properties, and one of them is a test about a test. The list of tables a reset empties is
// written by hand — it needs an order and a sentence per table — so the thing most likely to go wrong
// with it is not the logic here but somebody adding a seventeenth table next year and never touching
// this file. That case cannot be caught by reasoning about `RESET_TABLES`; it is caught by comparing
// it with what `ensureSchema` actually creates, which is the last test below.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { INVARIANTS } from '../store/invariants.js';
import { ensureSchema } from '../store/postgres.js';
import { FakePostgres } from '../store/postgres-fake.js';
import type { LegalHold } from './retention.js';
import { holdsRefusingReset, InstallHeld, planReset, resetInstall, RESET_TABLES, type ResetGateway } from './reset.js';

const NOW = new Date('2026-08-06T09:00:00.000Z');

/** Every `.ts` under the server that is not a test, so the check reads what runs. */
function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

class Gateway implements ResetGateway {
  readonly emptied: string[] = [];
  /** Set when the emptying was rolled back, so a test can assert the undo happened rather than infer it. */
  rolledBack = false;
  /** How deep `resetting` is, so nesting is visible to a test rather than merely unlikely. */
  private depth = 0;
  private rows: Record<string, number>;
  /** Thrown by `empty` for this table, standing in for a database that fails part-way through. */
  private readonly failOn?: string;

  constructor(rows: Readonly<Record<string, number>> = {}, failOn?: string) {
    this.rows = { ...rows };
    if (failOn != null) this.failOn = failOn;
  }

  countRows(table: string): Promise<number> {
    return Promise.resolve(this.rows[table] ?? 0);
  }

  empty(table: string): Promise<number> {
    if (this.depth === 0) throw new Error(`empty(${table}) outside resetting(): this must be one transaction`);
    if (table === this.failOn) return Promise.reject(new Error(`${table}: connection reset by peer`));
    this.emptied.push(table);
    const held = this.rows[table] ?? 0;
    this.rows[table] = 0;
    return Promise.resolve(held);
  }

  /** The transaction, modelled the way the fake database models it: keep a copy, put it back on a throw. */
  async resetting<T>(run: (within: Gateway) => Promise<T>): Promise<T> {
    const before = { ...this.rows };
    this.depth += 1;
    try {
      return await run(this);
    } catch (cause) {
      this.rows = before;
      this.emptied.length = 0;
      this.rolledBack = true;
      throw cause;
    } finally {
      this.depth -= 1;
    }
  }
}

/** A hold reader, since `resetInstall` reads them rather than being handed them. */
const inForce =
  (...holds: readonly LegalHold[]) =>
  (): Promise<readonly LegalHold[]> =>
    Promise.resolve(holds);

function hold(over: Partial<LegalHold> = {}): LegalHold {
  return {
    id: 'hold-1',
    reason: 'Litigation hold for the Q3 dispute',
    covers: ['assessment'],
    placedBy: 'priya@example.com',
    placedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  };
}

describe('what a reset would destroy', () => {
  it('counts every table, so the act says what it reaches', async () => {
    const plan = await planReset(new Gateway({ scans: 40, notes: 3 }), [], NOW);

    expect(plan.tables.map((one) => one.table)).toEqual(RESET_TABLES.map((one) => one.table));
    expect(plan.tables.find((one) => one.table === 'scans')?.rows).toBe(40);
  });

  /*
   * The empty ones too. A list that showed only the tables with rows in them would shrink as the
   * install emptied and would never quite say what the act covers — and `audit_floor: 0` is the line
   * that tells a reader this reaches the thing that explains their trail.
   */
  it('lists the empty tables rather than hiding them', async () => {
    const plan = await planReset(new Gateway({ scans: 1 }), [], NOW);
    expect(plan.tables).toHaveLength(RESET_TABLES.length);
    expect(plan.tables.every((one) => one.rows >= 0)).toBe(true);
  });

  /*
   * The count the confirmation is made against excludes the trail, and this is the reason. Every
   * refused reset appends an event, so a total that included them would be a number that moved every
   * time somebody got it wrong — refuse, quote the new number, refuse again by one, forever.
   */
  it('separates what an administrator is deciding about from the trail', async () => {
    const plan = await planReset(new Gateway({ scans: 40, notes: 2, audit_events: 900 }), [], NOW);

    expect(plan.records).toBe(42);
    expect(plan.events).toBe(900);
  });

  it('says which tables a sweep can never reach, since that is why a reset exists', () => {
    const never = RESET_TABLES.filter((one) => !one.swept).map((one) => one.table);
    expect(never).toContain('assessment_definitions');
    expect(never).toContain('assessment_definition_versions');
    expect(never).toContain('retention_periods');
    expect(never).toContain('legal_holds');
  });

  /*
   * Any hold at all, whatever it covers. A reset crosses all three classes, so a hold over `temporary`
   * refuses it just as one over `governance` does: there is no partial reset that would honour the
   * first and empty the rest, and half-emptying an install under a hold is the outcome a hold exists
   * to prevent.
   */
  it('is refused by a hold over any class', async () => {
    const plan = await planReset(new Gateway(), [hold({ covers: ['temporary'] })], NOW);
    expect(plan.heldBy.map((one) => one.id)).toEqual(['hold-1']);
  });

  it('is not refused by a hold somebody lifted', async () => {
    const lifted = hold({ releasedBy: 'sam@example.com', releasedAt: new Date('2026-07-20T00:00:00.000Z') });
    const plan = await planReset(new Gateway(), [lifted], NOW);
    expect(plan.heldBy).toEqual([]);
  });

  it('names a hold once however many classes it covers', () => {
    const wide = hold({ covers: ['temporary', 'assessment', 'governance'] });
    expect(holdsRefusingReset([wide]).map((one) => one.id)).toEqual(['hold-1']);
  });
});

describe('the reset itself', () => {
  it('empties every table and answers what it held', async () => {
    const gateway = new Gateway({ scans: 40, notes: 2, audit_events: 900 });
    const reset = await resetInstall(gateway, inForce(), 'priya@example.com', NOW);

    expect(gateway.emptied).toEqual(RESET_TABLES.map((one) => one.table));
    expect(reset.rows).toBe(942);
    // Three of sixteen held anything. Reported rather than the list length, so a reset of an empty
    // install is honest about having removed nothing from nowhere.
    expect(reset.tables).toBe(3);
    expect(reset.by).toBe('priya@example.com');
  });

  /*
   * The chain last, and the floor after it. Both halves are load-bearing and neither is visible from
   * reading `RESET_TABLES` in a hurry: the log is where a reset that throws partway through gets
   * recorded, and a floor emptied before the events it accounts for would leave verification reporting
   * a gap this app caused and can no longer explain.
   */
  it('empties the trail last, and the floor after the trail', async () => {
    const gateway = new Gateway({ scans: 1 });
    await resetInstall(gateway, inForce(), 'priya@example.com', NOW);

    expect(gateway.emptied.slice(-2)).toEqual(['audit_events', 'audit_floor']);
  });

  it('reports having removed nothing from an install that was already empty', async () => {
    const reset = await resetInstall(new Gateway(), inForce(), 'priya@example.com', NOW);
    expect(reset.rows).toBe(0);
    expect(reset.tables).toBe(0);
  });

  /*
   * Refused here as well as at the route. The route is what produces the message a person reads, and
   * this is what stops the second caller — A4's supervisor, running this from a job — from being the
   * one place the guarantee does not hold.
   */
  it('refuses a held install and removes nothing at all', async () => {
    const gateway = new Gateway({ scans: 40 });
    await expect(resetInstall(gateway, inForce(hold()), 'priya@example.com', NOW)).rejects.toBeInstanceOf(InstallHeld);
    expect(gateway.emptied).toEqual([]);
  });

  it('names the hold in the refusal, since that is what has to be lifted', async () => {
    const held = resetInstall(new Gateway(), inForce(hold({ id: 'hold-9' })), 'priya@example.com', NOW);
    await expect(held).rejects.toThrow('hold-9');
  });

  /*
   * The failure this being a transaction exists for.
   *
   * Sixteen tables emptied one statement at a time can stop in the middle, and an install that has lost
   * its scans but kept its answers is a state no page describes and no record explains — while the
   * caller is being told the reset failed. So the whole thing goes back.
   */
  it('puts everything back when the database gives out part way through', async () => {
    const gateway = new Gateway({ scans: 40, notes: 2, decisions: 5 }, 'decisions');

    await expect(resetInstall(gateway, inForce(), 'priya@example.com', NOW)).rejects.toThrow('connection reset');

    expect(gateway.rolledBack).toBe(true);
    expect(await gateway.countRows('scans')).toBe(40);
    expect(await gateway.countRows('notes')).toBe(2);
  });

  /*
   * A hold placed after the plan was read and before the emptying starts. The reader is called inside
   * the transaction for exactly this, so a hold that arrives in that window refuses the reset rather
   * than being deleted by it — `legal_holds` being one of the tables a reset empties is what makes the
   * alternative so bad: the hold would be gone, and so would the evidence there had been one.
   */
  it('refuses a hold that arrives after the plan was read, rather than emptying it away', async () => {
    const gateway = new Gateway({ scans: 40, legal_holds: 1 });
    let reads = 0;
    const arriving = (): Promise<readonly LegalHold[]> => {
      reads += 1;
      return Promise.resolve(reads === 1 ? [] : [hold({ id: 'hold-late' })]);
    };

    // Read once for a plan, the way the route does, and then the reset reads again for itself.
    await planReset(gateway, await arriving(), NOW);
    await expect(resetInstall(gateway, arriving, 'priya@example.com', NOW)).rejects.toThrow('hold-late');

    expect(gateway.emptied).toEqual([]);
    expect(await gateway.countRows('legal_holds')).toBe(1);
  });

  it('empties inside one transaction, so nothing it removes is visible half-done', async () => {
    const gateway = new Gateway({ scans: 3 });
    // `Gateway.empty` throws when it is called outside `resetting`, so this passing is the assertion.
    await expect(resetInstall(gateway, inForce(), 'priya@example.com', NOW)).resolves.toBeDefined();
  });
});

describe('the list of tables against the schema it is a list of', () => {
  /*
   * The test this file exists for.
   *
   * `RESET_TABLES` is written by hand, so the failure worth catching is a table added to the schema in
   * a year's time that nobody thought to add here — data that quietly survives being emptied, in a
   * feature whose entire promise is that nothing does. Compared against what `ensureSchema` creates
   * rather than against a second list, because a second list is the same bug with more steps.
   */
  it('covers every table the app creates, and invents none', async () => {
    const fake = new FakePostgres();
    await ensureSchema(fake, fake.schema);

    const created = new Set(
      fake.statements
        .map((sql) => /^create table if not exists \S+\.(\w+)/.exec(sql)?.[1])
        .filter((name): name is string => name != null)
    );

    expect(new Set(RESET_TABLES.map((one) => one.table))).toEqual(created);
  });

  it('names each table once', () => {
    const named = RESET_TABLES.map((one) => one.table);
    expect(new Set(named).size).toBe(named.length);
  });

  /*
   * The failure `148` found, checked against the source that creates the constraints rather than a
   * second hand-written edge list. `RESET_TABLES` predates the Version 2 final-result foreign keys;
   * the reset test kept agreeing with its own order while Postgres correctly refused to delete a
   * scan that a result still cited. Any later restricted foreign key now has to move its child ahead
   * of its parent in this list before the reset suite can pass.
   */
  it('empties every restricted foreign-key child before its parent', () => {
    const position = new Map(RESET_TABLES.map((one, index) => [one.table, index]));
    const declared = INVARIANTS.filter((invariant) => invariant.sql('waf').includes(' foreign key '));
    const foreignKeys = INVARIANTS.flatMap((invariant) => {
      const match = /alter table \S+\.(\w+) add constraint (\w+) foreign key \([^)]+\) references \S+\.(\w+)/.exec(
        invariant.sql('waf')
      );
      return match == null ? [] : [{ child: match[1], name: match[2], parent: match[3] }];
    });

    // A changed DDL shape may not silently fall out of the parser and make the check weaker.
    expect(foreignKeys.map((foreignKey) => foreignKey.name)).toEqual(declared.map((invariant) => invariant.name));
    for (const foreignKey of foreignKeys) {
      const child = position.get(foreignKey.child);
      const parent = position.get(foreignKey.parent);
      expect(child, `${foreignKey.name}: child ${foreignKey.child} is absent from reset`).toBeDefined();
      expect(parent, `${foreignKey.name}: parent ${foreignKey.parent} is absent from reset`).toBeDefined();
      expect(child!, `${foreignKey.name}: ${foreignKey.child} must be emptied before ${foreignKey.parent}`).toBeLessThan(
        parent!
      );
    }
  });

  /*
   * The classification `42b` added, held by the same test above rather than by a second list.
   *
   * A table added to the schema fails `covers every table the app creates` until it appears here, and
   * appearing here means the type demands a `context`. That is the whole enforcement: there is no way
   * to add a durable table without saying which assessment its rows belong to, and no document to go
   * stale. The tests below check what a type cannot.
   */
  it('gives a reason per table that is written and is not the sentence above it', () => {
    // Deliberately weak, and named for what it does rather than for what would be nice. A length and
    // an inequality cannot tell a reason from a plausible-looking sentence — `'scoped because it is
    // scoped'` passes both — so the honest claim is that an empty or copy-pasted `because` fails and
    // nothing else here does. What holds the reasons to the code is the walk and the writer check
    // below, and review.
    for (const one of RESET_TABLES) {
      expect(one.context.because.length).toBeGreaterThan(20);
      expect(one.context.because).not.toBe(one.holds);
    }
  });

  it('scopes a table through its parent only when following the parents reaches a scoped one', () => {
    /*
     * The mistake this catches was made twice while writing the list. The definition versions and the
     * audit floor both have an obvious parent, and both parents are installation-wide, so neither
     * child is scoped to anything — `by-parent` on either would have claimed a scope that does not
     * exist anywhere up the chain.
     *
     * Followed rather than checked one level, because `validation_attempts` declares
     * `improvement_actions` as its parent and that table is itself `by-parent`. Being two hops is a
     * consequence of that declaration rather than a fact about the schema — the table carries
     * `plan_id` as well, so it could have been declared one hop from `improvement_plans` instead. The
     * point of the walk is that the declaration can name the row an attempt actually belongs to,
     * which is an action, rather than the nearest ancestor that makes a one-level check pass.
     */
    const byTable = new Map(RESET_TABLES.map((one) => [one.table, one]));
    const byParent = RESET_TABLES.filter((one) => one.context.kind === 'by-parent');
    expect(byParent.length).toBeGreaterThan(0);

    for (const child of byParent) {
      const walked: string[] = [child.table];
      let at = child;

      // Bounded by the list's own length, so a cycle ends the walk instead of the process.
      while (at.context.kind === 'by-parent' && walked.length <= RESET_TABLES.length) {
        const parent = byTable.get(at.context.parent);
        expect(parent, `${at.table}: parent “${at.context.parent}” is not a table`).toBeDefined();
        at = parent!;
        walked.push(at.table);
      }

      expect(at.context.kind, `${child.table}: ${walked.join(' → ')} ends somewhere unscoped`).toBe('scoped');
    }
  });

  it('reaches the schema with the classification, for every scoped table', async () => {
    /*
     * What this does and does not establish, stated plainly, because the obvious reading of it is
     * wrong and a reviewer measured that.
     *
     * `ensureSchema` reads `RESET_TABLES` to decide what to alter, so both sides of the comparison
     * below move together. Reclassifying `notes` as installation-wide stops keying it *and* removes
     * it from the expectation, and this test still passes — that was tried. It cannot be the check
     * that a classification is right, and a comment claiming it was would be the `bounds.ts` failure
     * `AGENTS.md` names, in the change whose own argument is that a cheap claim should be enforced.
     *
     * What it holds is the wiring: that `keyByAssessment` is still reached from `ensureSchema`, that
     * it still emits an `alter` per scoped table, and that the column is still called what every read
     * `42c` writes will name. Delete the call, rename the column, or narrow the loop, and this fails.
     * The classification itself is held by the test below, which does not read the classification.
     */
    const fake = new FakePostgres();
    await ensureSchema(fake, fake.schema);

    const keyed = new Set(
      fake.statements
        .map((sql) => /^alter table \S+\.(\w+) add column if not exists definition_id/.exec(sql)?.[1])
        .filter((name): name is string => name != null)
    );
    const scoped = RESET_TABLES.filter((one) => one.context.kind === 'scoped').map((one) => one.table);

    expect(keyed).toEqual(new Set(scoped));
    // Not vacuous, and not the whole list either: if this ever equals `RESET_TABLES.length` the
    // classification has stopped classifying.
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.length).toBeLessThan(RESET_TABLES.length);
  });

  it('classifies as scoped every table something writes an assessment key into', () => {
    /*
     * The independent half, and the one with teeth: evidence from outside the classification.
     *
     * A store that writes `definition_id` has settled the question for its table by doing it, so a
     * classification saying that table is the installation's contradicts code that is already
     * running. This reads the server's own insert statements and needs nothing from `RESET_TABLES`
     * but the answer it is checking, which is what the test above cannot say for itself.
     *
     * It is one-directional on purpose. A scoped table with no writer would be a classification
     * waiting on a store, and the named list below is what fails when a writer is added without
     * appearing here.
     */
    const server = fileURLToPath(new URL('..', import.meta.url));
    const writers = new Set<string>();

    for (const file of sourceFilesUnder(server)) {
      const source = readFileSync(file, 'utf8');
      // The table an insert names, when that insert's column list mentions the key. Both the table
      // and the column list can wrap, so this reads to the closing bracket rather than to a newline.
      for (const [, table, interpolated, columns] of source.matchAll(
        /insert into \$\{[^}]*schema\}\.(?:(\w+)|\$\{(\w+)\})\s*\(([^)]*)\)/g
      )) {
        if (!/\bdefinition_id\b/.test(columns)) continue;
        // Attestations and decisions share one insert, with the table interpolated from a union of
        // those two names. The regex sees the interpolation, not the tables; both are the writers.
        if (interpolated === 'table') {
          writers.add('attestations');
          writers.add('decisions');
          continue;
        }
        if (table != null) writers.add(table);
      }
    }

    const scoped = new Set(RESET_TABLES.filter((one) => one.context.kind === 'scoped').map((one) => one.table));

    // Named, so a writer that stops writing the key shows up here as a missing table rather than as a
    // set that quietly got smaller.
    expect([...writers].sort()).toEqual([
      'accepted_risks',
      'advisories',
      'applicability_decisions',
      'assessment_definition_versions',
      'assessment_results',
      'assessment_reviews',
      'assessment_setup_drafts',
      'attestations',
      'decisions',
      'improvement_plans',
      'month_publications',
      'notes',
      'runs',
      'scans',
      'serving_declarations',
    ]);

    for (const table of writers) {
      // The one exemption, and it is the reason this test is worth more than the count it produces.
      // `assessment_definition_versions` writes a `definition_id` that is the identity of the
      // definition it is a version of, not the assessment its row belongs to — the same column name
      // meaning something else. A read in `42c` that filters every `definition_id` alike would treat
      // a definition's own identity as a scope and hide every version of every other assessment from
      // the list that has to show all of them.
      if (table === 'assessment_definition_versions') continue;
      expect(scoped.has(table), `${table} is written with an assessment key but classified otherwise`).toBe(true);
    }
  });

  it('says what each one holds, in words rather than as a table name', () => {
    for (const one of RESET_TABLES) {
      expect(one.holds.length).toBeGreaterThan(20);
      expect(one.holds).not.toContain('_');
    }
  });
});
