// Types for what `measure-shape-fingerprint.mjs` exports so a test can hold the corpus and the
// normalisation against the statement that ships them. The script stays JavaScript for the reason its
// header gives — it runs straight from source with no build step, like every other live script here.

/**
 * The shipped fingerprint's normalisation over any input expression.
 *
 * Rendered over the statement's own input, this has to appear verbatim inside
 * `config/statements/workload_query_shapes.sql`, or the measurement is describing a fingerprint we do not
 * ship. `measure-shape-fingerprint.test.ts` is what holds that.
 */
export function normalisation(input: string): string;

/** One statement written to exercise a claimed failure mode. */
export interface ShapeFixture {
  readonly id: string;
  readonly text: string;
}

/**
 * What the fingerprint should do to a pair of fixtures, and whether it does.
 *
 * `want` is the intended behaviour and `held` is whether the shipped fingerprint achieves it, so the
 * declaration states the specification and the gap in one place. `is` is added by the measurement.
 */
export interface ShapeRelation {
  readonly left: string;
  readonly right: string;
  readonly want: 'same' | 'different';
  readonly held: boolean;
  readonly mode: string;
}

export const FIXTURES: readonly ShapeFixture[];
export const RELATIONS: readonly ShapeRelation[];
