import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { guidanceDirectory } from './guidance.js';

/**
 * The rule that makes the guidance phase mean anything: `status: authored` is a claim, and the schema
 * is what holds the claim to the fields a reader needs.
 *
 * `scripts/check-guidance.mjs` runs this schema over the shipped files, and this asserts the rule the
 * script depends on. The distinction is worth keeping: the script would still pass if the conditional
 * requirement were quietly deleted from the schema, because every shipped entry happens to satisfy it
 * today. These fixtures fail in that case, which is the point.
 */

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(join(guidanceDirectory(), 'guidance.schema.json'), 'utf8')) as object);

const COMPLETE = {
  status: 'authored',
  last_reviewed: '2026-08-02',
  owner_role: 'Platform owner',
  means: 'What the practice means, said plainly and at enough length to clear the minimum.',
  matters: 'The consequence of not doing it, said as a risk rather than as a virtue statement.',
  good: ['The first concrete signal of good.', 'The second concrete signal of good.'],
  examples: {
    strong: 'What a strong answer looks like in a real estate, at length.',
    partial: 'What a partial answer looks like in a real estate, at length.',
    weak: 'What a weak answer looks like in a real estate, at some length.',
  },
  verify: [{ how: 'ui', where: 'Compute > Policies, and the policies two teams actually use', expect: 'A policy on each cluster' }],
  pitfalls: ['The way this gets got wrong while looking right.'],
  partial_when: 'When the practice covers some of the estate and not the rest of it.',
};

function guidance(entry: unknown) {
  return { pillar: 'reliability', entries: { 'REL-01-02': entry } };
}

function refuses(entry: unknown): string[] {
  const valid = validate(guidance(entry));
  expect(valid).toBe(false);
  return (validate.errors ?? []).map((one) => `${one.instancePath} ${one.message ?? ''}`);
}

describe('the guidance schema', () => {
  it('accepts a complete authored entry', () => {
    expect(validate(guidance(COMPLETE))).toBe(true);
  });

  it('accepts a scaffold that claims nothing but its status', () => {
    expect(validate(guidance({ status: 'draft' }))).toBe(true);
  });

  /*
   * The half-authored entry, which is the failure mode this schema exists for.
   *
   * It is not hypothetical: authoring 63 entries over several sittings means entries that are three
   * fields in when the day ends, and the only difference between "in progress" and "shipped
   * half-written" is whether somebody remembered to leave `status` alone.
   */
  it.each(['last_reviewed', 'owner_role', 'means', 'matters', 'good', 'examples', 'verify', 'pitfalls', 'partial_when'])(
    'refuses an authored entry missing %s',
    (field) => {
      const { [field]: _dropped, ...rest } = COMPLETE as Record<string, unknown>;
      expect(refuses(rest).join(' ')).toContain(field);
    }
  );

  it('lets a draft omit everything the same authored entry would need', () => {
    expect(validate(guidance({ status: 'draft', means: 'Something somebody started and did not finish tonight.' }))).toBe(true);
  });

  /*
   * Length floors, which are the part that stops 'TBD' from satisfying the field list.
   *
   * A required field with no minimum is a required field somebody fills with a placeholder to make the
   * check pass, and a placeholder that reaches a customer is worse than an empty panel because it
   * looks like an answer.
   */
  it('refuses a placeholder in a required field', () => {
    expect(refuses({ ...COMPLETE, means: 'TBD' }).join(' ')).toContain('fewer than 40 characters');
  });

  it('refuses one worked example in place of three', () => {
    expect(refuses({ ...COMPLETE, examples: { strong: COMPLETE.examples.strong } }).join(' ')).toMatch(/partial|weak/);
  });

  it('refuses a single signal of good, because a rubric of one is a restatement of the title', () => {
    expect(refuses({ ...COMPLETE, good: ['Only the one signal, which is not a rubric.'] }).join(' ')).toContain('fewer than 2 items');
  });

  it('refuses a verification step with no location', () => {
    expect(refuses({ ...COMPLETE, verify: [{ how: 'ui' }] }).join(' ')).toContain('where');
  });

  it('refuses a verification kind it cannot render', () => {
    expect(refuses({ ...COMPLETE, verify: [{ how: 'telepathy', where: 'Ask the platform team about it' }] }).join(' ')).toContain(
      'allowed values'
    );
  });

  it('refuses a review date that is not a date', () => {
    expect(refuses({ ...COMPLETE, last_reviewed: 'last summer' }).join(' ')).toContain('date');
  });

  it('refuses a field nobody defined, so a typo is not silently dropped', () => {
    expect(refuses({ ...COMPLETE, pitfals: ['Spelled wrong, and would have vanished.'] }).join(' ')).toContain('additional properties');
  });

  it('refuses a control id that is not one', () => {
    expect(validate({ pillar: 'reliability', entries: { 'REL-1-2': COMPLETE } })).toBe(false);
  });

  it('refuses a file that does not say which pillar it covers', () => {
    expect(validate({ entries: { 'REL-01-02': COMPLETE } })).toBe(false);
  });

  it('does not require not_applicable_when, because most requirements always apply', () => {
    expect(validate(guidance(COMPLETE))).toBe(true);
    expect(validate(guidance({ ...COMPLETE, not_applicable_when: 'When the workspace holds no production workload.' }))).toBe(true);
  });
});

/*
 * The six dimensions L1b added, held to the same rule as `examples` and for the same reason.
 *
 * Optional as a block, because 63 entries were authored against a contract that did not have them and
 * requiring it would have unauthored the corpus on the day the schema changed. Complete once present,
 * because the six are one argument: a recommendation whose trade-offs are missing is a recommendation
 * with its cost hidden, and the panel cannot tell a field somebody left out from one they had nothing
 * to say about.
 */
const ADVICE = {
  start_from: 'The safe default for a customer with no policy yet, stated as something to adopt on Monday.',
  depends_on: [
    'The first condition that changes that default, and what it changes it to.',
    'The second condition that changes it, and what it changes it to instead.',
  ],
  path: [
    'Find out what the estate actually does today, which is the step people skip.',
    'Then move it to the baseline, which is where most of the value is.',
  ],
  costs: ['What this costs to run, in money or in somebody spending a week on it.'],
  retain: 'The dated artefact that proves this at the next review, named specifically.',
  revisit: 'The event that should reopen the decision, rather than a date somebody defers.',
};

describe('the advice block', () => {
  it('accepts an authored entry with all six dimensions', () => {
    expect(validate(guidance({ ...COMPLETE, advice: ADVICE }))).toBe(true);
  });

  it('accepts an authored entry with none of them, so the older corpus stays authored', () => {
    expect(validate(guidance(COMPLETE))).toBe(true);
  });

  it.each(Object.keys(ADVICE))('refuses an advice block missing %s', (field) => {
    const partial = Object.fromEntries(Object.entries(ADVICE).filter(([key]) => key !== field));
    expect(refuses({ ...COMPLETE, advice: partial }).join(' ')).toContain(field);
  });

  it('refuses a single-stage path, because one step is a target rather than a route', () => {
    expect(refuses({ ...COMPLETE, advice: { ...ADVICE, path: [ADVICE.path[0]] } }).join(' ')).toContain('fewer than 2 items');
  });

  it('refuses one decision factor, because a rule with one exception has one author', () => {
    expect(refuses({ ...COMPLETE, advice: { ...ADVICE, depends_on: [ADVICE.depends_on[0]] } }).join(' ')).toContain(
      'fewer than 2 items'
    );
  });

  it('refuses an empty costs list rather than reading it as costing nothing', () => {
    expect(refuses({ ...COMPLETE, advice: { ...ADVICE, costs: [] } }).join(' ')).toContain('fewer than 1 items');
  });

  it('refuses a dimension nobody defined, so a renamed field is not silently dropped', () => {
    expect(refuses({ ...COMPLETE, advice: { ...ADVICE, review_trigger: 'Renamed by hand.' } }).join(' ')).toContain(
      'additional properties'
    );
  });
});
