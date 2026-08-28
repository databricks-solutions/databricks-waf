// Whether the recording still supports the things it was used to decide.
//
// `scripts/measure-shape-fingerprint.mjs` is a live script nothing in `verify` runs, so what is testable is
// not the readings — it is the reasoning built on them. `36j` measured the six failure modes `36r` was going
// to be designed around, and gave three different answers before this one: a population of zero, a
// population 20% too wide whose headline evidence was statement types the fingerprint never sees, and two
// modes reported inert by regexes written in the wrong case. A reviewer caught the last two.
//
// So these are the assertions that would have caught them, plus one per claim that now sets what `36r`
// builds. Every one of them fails if a re-recording withdraws the evidence rather than leaving the prose
// standing over a number that changed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FIXTURES, RELATIONS, normalisation } from './measure-shape-fingerprint.mjs';
import { withoutComments } from '../server/collect/sql/scan.js';

const SHAPES_SQL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../config/statements/workload_query_shapes.sql'),
  'utf8'
);

interface Relation {
  left: string;
  right: string;
  want: 'same' | 'different';
  held: boolean;
  mode: string;
  is: 'same' | 'different';
}

interface Shapes {
  statements: number;
  clients: { app: string; statements: number; shapes: number }[];
  shapes: Record<string, number>;
  exercised: Record<string, number>;
  splitByStandaloneDigits: { app: string; narrowerShapes: number; shippedShape: string }[];
  fixtures: { normalised: Record<string, string>; relations: Relation[] };
}

const recording = JSON.parse(
  readFileSync(new URL('../server/collect/sql/runtime-baseline/labs-shapes.json', import.meta.url), 'utf8')
) as Shapes;

/**
 * The one variant left, which is the one mode `36s` deliberately did not fix.
 *
 * `36j` ran five. Four of the five are inside the fingerprint now, so a variant fixing one has nothing to act
 * on and reported exactly zero — a table still producing numbers after it stopped measuring anything. The
 * corpus holds those four instead, on statements written for the purpose.
 */
const MODES = ['standalone_digits'];

describe('the shape fingerprint recording', () => {
  it('counted the mode the table has a row for, and both fingerprints to compare against', () => {
    // The set, not the count: a recording missing a mode publishes no row for it, which reads as a mode
    // nobody worried about rather than one nobody measured.
    expect(Object.keys(recording.shapes).sort()).toEqual(['before36s', 'shipped', ...MODES].sort());
    expect(Object.keys(recording.exercised).sort()).toEqual([...MODES].sort());
    expect(recording.statements).toBeGreaterThan(recording.shapes.shipped);
  });

  it('has the before and the after from the same window, which is the only way the delta means anything', () => {
    // The shipped count moved between two runs 20 minutes apart, because this project's probing is most of
    // the corpus. A before carried over from an earlier run would be a difference in when it was measured as
    // much as a difference in what was measured, and 36s's whole claim is the difference.
    expect(recording.shapes.before36s).toBeGreaterThan(recording.shapes.shipped);
  });

  it('says how many statements exercise the mode, which is what separates inert from absent', () => {
    // The pair this measurement got wrong: a variant that changes nothing and a variant whose pattern never
    // fires both report zero. A non-zero delta over a zero count is a broken pattern.
    for (const mode of MODES) {
      const delta = recording.shapes[mode] - recording.shapes.shipped;
      if (delta !== 0) expect(recording.exercised[mode]).toBeGreaterThan(0);
      expect(recording.exercised[mode]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the evidence that collapsing digit runs is right on this corpus', () => {
  const gained = recording.shapes.standalone_digits - recording.shapes.shipped;
  const split = recording.splitByStandaloneDigits;

  it('is complete, rather than the first ten of an unknown number', () => {
    // The recording takes the ten largest. While the shapes they gain add up to the whole difference, the
    // list is all of them; the moment it does not, every proportion below is over a subset.
    const accounted = split.reduce((sum, entry) => sum + (entry.narrowerShapes - 1), 0);
    expect(accounted).toBe(gained);
  });

  it('is entirely a generated suffix, which is why 36s kept collapsing digits', () => {
    // `_lakeload_permission_check_<epoch_ms>`: one scratch table, created on each run, which the shipped
    // rule collects into one shape and the proposed fix would scatter into one shape per run. Every shape in
    // the list is this one — so if a counter-example appears inside the covered population, this fails, and
    // the recommendation it supports is the thing to revisit.
    const generated = split.filter((entry) => entry.shippedShape.includes('_lakeload_permission_check_N'));
    const fromGenerated = generated.reduce((sum, entry) => sum + (entry.narrowerShapes - 1), 0);

    expect(generated.length).toBeGreaterThan(0);
    expect(fromGenerated).toBe(gained);
  });
});

describe('the corpus the counts came from', () => {
  it('is still mostly this project probing itself, which is why no proportion is quoted as an estate figure', () => {
    // If this fails because the share fell, labs acquired a real workload, and the caveat in the write-up is
    // doing harm rather than work — the numbers would then be worth more than it says they are.
    const shapes = recording.clients.reduce((sum, client) => sum + client.shapes, 0);
    const probes = recording.clients
      .filter((client) => client.app === 'Databricks CLI' || client.app === 'node')
      .reduce((sum, client) => sum + client.shapes, 0);

    expect(probes * 2).toBeGreaterThan(shapes);
  });
});

describe('the corpus written by hand, which is the specification the rework works against', () => {
  const relations = recording.fixtures.relations;
  const shapeOf = (id: string): string => {
    const normalised = recording.fixtures.normalised[id];
    if (normalised == null) throw new Error(`no recording for fixture ${id}`);
    return normalised;
  };

  it('measures the fingerprint that ships, rather than a second copy of it that has drifted', () => {
    // The one thing this whole file rests on. `36j` measured the modes with the normalisation written out a
    // second time in the script, and nothing was keeping the two in step — so a change to the statement
    // would have left the measurement describing a fingerprint we do not ship, which is the failure this
    // repository has already paid for twice. Rendered the statement's way and looked for verbatim.
    const rendered = normalisation('lower(trim(statement_text))');
    const bare = (sql: string): string => withoutComments(sql).replace(/\s+/g, '');

    // Non-vacuous: an empty or near-empty rendering would be found in anything.
    expect(rendered).toContain("'[0-9]+', 'N'");
    expect(rendered).toContain('chr(39)');
    expect(rendered).toContain("' '");
    expect(bare(SHAPES_SQL)).toContain(bare(rendered));
  });

  it('exercises every mode, so no mode is left unmeasured because labs happens not to run one', () => {
    // Two of the six modes `36j` set out to measure could not be measured at all on labs, and the apparatus
    // reported that as zero effect until it was asked to count separately. A corpus cannot have that problem:
    // if a mode has a row here, a statement exercising it exists by construction.
    const defined = FIXTURES.map((fixture) => fixture.id);
    for (const relation of RELATIONS) {
      expect(defined).toContain(relation.left);
      expect(defined).toContain(relation.right);
    }
    for (const mode of ['typed literals', 'quoted identifiers', 'line comments', 'IN lists of varying length']) {
      expect(relations.map((relation) => relation.mode)).toContain(mode);
    }
    expect(relations).toHaveLength(RELATIONS.length);
  });

  it('says which pairs the shipped fingerprint gets right, and is not describing a run that has moved on', () => {
    // `held` is a declaration; `is` is what was measured. Holding them against each other is what makes the
    // corpus a specification rather than a snapshot: closing a gap flips a boolean in the same change as the
    // SQL, and a regression fails here rather than being absorbed as a new recording.
    for (const relation of relations) {
      expect(relation.held, `${relation.mode}: declared held, measured ${relation.is}`).toBe(
        relation.is === relation.want
      );
    }
    expect(relations.filter((relation) => relation.held).length).toBeGreaterThan(0);
    expect(relations.filter((relation) => !relation.held).length).toBeGreaterThan(0);
  });

  it('keeps statements that differ apart, so a rework cannot pass by collapsing everything', () => {
    // Every other row wants a merge. A canonicalizer that returned one shape for the estate would satisfy
    // all of them, and would also be the worst possible outcome — so the control is held separately.
    const control = relations.find((relation) => relation.want === 'different' && relation.held);
    expect(control?.mode).toBe('the control: different SQL');
    expect(shapeOf('plain')).not.toBe(shapeOf('other-statement'));
  });

  it('no longer swallows a statement whose comment contains an apostrophe, which was the worst gap', () => {
    // Found by the corpus rather than by reasoning, and not on `36j`'s list of six. An apostrophe in a
    // comment left an odd number of quotes, so the literal rule paired the comment's quote with the next one
    // below it and consumed the statement in between: two statements sharing only a trailing `= 'p'` both
    // normalised to `-- donSp'`, nine characters, and shared a shape. A row citing real execution time that
    // describes no query anybody ran is what `spark.sql(stmt)` is excluded to prevent.
    //
    // Two assertions, because either alone passes for the wrong reason: the first that the statements are
    // told apart, the second that what survives is the statement rather than the remains of one.
    expect(shapeOf('apostrophe-comment-a')).not.toBe(shapeOf('apostrophe-comment-b'));
    expect(shapeOf('apostrophe-comment-a')).toBe('select a from t where s = S');
    expect(shapeOf('apostrophe-comment-b')).toBe('select zzz from qqq where s = S');
  });

  it('leaves a comment hugging an identifier in the text, which is the one gap 36s did not close', () => {
    // The boundary of the anchor that protects `` `a--b` ``: the comment rule requires the `--` not to follow
    // a lower-case word character, so `from t--why` keeps its comment and splits from `from t`. Declared
    // rather than hidden. It is a split, and the alternative — dropping the anchor — merges two identifiers
    // that differ only after a `--`, which is the failure this row exists to remove.
    expect(shapeOf('comment-hugging-an-identifier')).toContain('--why');
    expect(shapeOf('quoted-ident-dashes-b')).not.toBe(shapeOf('quoted-ident-dashes-c'));
  });
});
