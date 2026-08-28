// Whether the benchmark's records are as wide as the records the app writes.
//
// This is the gate `scale.test.ts` grew after H1's first measurement was taken with a fixture one
// column narrower than the statement it claimed to measure. The number that came back was real,
// reproducible and about a query that does not exist, and a reviewer caught it rather than a test. The
// same mistake here would read as a history budget an install comfortably fits inside, because every
// read in the budget pays for the whole `jsonb` body and a thin body is a cheap read.
//
// So the fields are not listed here. They are read out of the type declarations with the TypeScript
// compiler, which is the only source that cannot drift from the record: a field added to `AcceptedRisk`
// and not to the fixture fails this test on the commit that adds it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { MIN_PROSE } from '../accept/risk.js';
import {
  actions,
  attestations,
  attempts,
  decisions,
  definition,
  note,
  plan,
  requirementIds,
  risks,
} from './history-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..');

/**
 * A field the fixture may leave out, and why. Every entry is a hole in the measurement.
 *
 * One entry, and it is priced in the published table rather than only here: an action raised from
 * advisor advice carries a provenance block a requirement-raised one does not, so `actionsFor` is
 * measured on the narrower of the two shapes the app writes.
 */
const EXEMPT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ImprovementAction: {
    advice:
      'an advice-raised action carries a provenance block a requirement-raised one has no field for; ' +
      'the fixture is the requirement-raised shape and the published table says the action numbers are ' +
      'a floor for an install whose work came from the advisor',
  },
};

/**
 * Every string in a record body, with the path that reaches it.
 *
 * Nested, because the fields most likely to be thinned are the ones inside something: an action's
 * transitions each carry their own reason, and a revocation carries one too.
 */
function strings(value: unknown, at = ''): readonly (readonly [string, string])[] {
  if (typeof value === 'string') return [[at, value]];
  if (value instanceof Date || value == null) return [];
  if (Array.isArray(value)) return value.flatMap((element, index) => strings(element, `${at}[${String(index)}]`));
  if (typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, held]) => strings(held, at === '' ? key : `${at}.${key}`));
}

/** Property names an interface declares, optional ones included, read from the source. */
function fieldsOf(file: string, name: string): readonly string[] {
  const path = join(SERVER, file);
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) found.push(member.name.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  if (found.length === 0) throw new Error(`No interface ${name} in ${file}, so nothing was checked.`);
  return found;
}

const PILLARS = ['security', 'reliability', 'cost-optimisation', 'operational-excellence', 'performance', 'governance', 'ai'];

/**
 * Every record type in the benchmark, with the declaration it must be as wide as.
 *
 * `object` rather than `Record<string, unknown>`, so a record can be listed here without an assertion:
 * what the two tests below do with a body is read its own keys and walk its strings, and neither needs
 * the record to claim an index signature it does not have.
 */
const SUBJECTS: readonly {
  readonly type: string;
  readonly file: string;
  readonly bodies: readonly object[];
}[] = [
  {
    type: 'Attestation',
    file: 'attest/attestation.ts',
    bodies: attestations('SEC-001-access', 3, 1),
  },
  {
    type: 'ApplicabilityDecision',
    file: 'apply/applicability.ts',
    bodies: decisions('SEC-001-access', 3, 3),
  },
  {
    type: 'AcceptedRisk',
    file: 'accept/risk.ts',
    bodies: risks('SEC-001-access', 3, 3),
  },
  {
    type: 'DefinitionVersion',
    file: 'define/definition.ts',
    // Version 1 declares no `note` — the field's own rule is that the first version changed nothing —
    // so the widest version rather than every one of them is what has to carry every field.
    bodies: definition('assessment-1', 3, 1, PILLARS).versions.slice(1),
  },
  {
    type: 'ImprovementPlan',
    file: 'improve/plan.ts',
    bodies: [plan('plan-4', 4)],
  },
  {
    type: 'ImprovementAction',
    file: 'improve/action.ts',
    bodies: actions('plan-5', ['SEC-001-access', 'GOV-002-lineage'], 4, 5),
  },
  {
    type: 'ValidationAttempt',
    file: 'validate/attempt.ts',
    // The answered pair, so `answer` is carried. The requested row of an unanswered attempt declines
    // it by design and would read here as a field the fixture forgot.
    bodies: attempts('plan-6', 'action-6', ['SEC-001-access', 'GOV-002-lineage'], 6, true),
  },
  {
    type: 'AttemptAnswer',
    file: 'validate/attempt.ts',
    bodies: attempts('plan-7', 'action-7', ['SEC-001-access'], 7, true)
      .map((attempt) => attempt.answer)
      .filter((answer): answer is NonNullable<typeof answer> => answer != null),
  },
  {
    type: 'Note',
    file: 'note/note.ts',
    bodies: [note('control', 'SEC-001-access', 8)],
  },
];

describe('the history-read fixtures', () => {
  for (const subject of SUBJECTS) {
    if (subject.bodies.length === 0) continue;

    it(`carries every field ${subject.type} declares`, () => {
      const declared = fieldsOf(subject.file, subject.type);
      const exempt = EXEMPT[subject.type] ?? {};
      const carried = new Set(subject.bodies.flatMap((body) => Object.keys(body)));

      const missing = declared.filter((field) => !carried.has(field) && exempt[field] == null);
      expect(missing, `${subject.type} fields no fixture populates`).toEqual([]);
    });

    it(`states a reason for every field of ${subject.type} it leaves out`, () => {
      const declared = new Set(fieldsOf(subject.file, subject.type));
      for (const [field, why] of Object.entries(EXEMPT[subject.type] ?? {})) {
        // An exemption for a field the record no longer declares is an exemption nobody is reading.
        expect(declared.has(field), `${subject.type}.${field} is exempt and not declared`).toBe(true);
        expect(why.length).toBeGreaterThan(40);
      }
    });
  }

  it('writes prose of the length a person writes, not a repeated character', () => {
    const [first] = attestations('SEC-001-access', 1, 1);
    expect(first?.statement.length).toBeGreaterThan(200);
    // Two hundred characters of one letter would compress in a way real prose does not, and the
    // column TOASTs above two kilobytes, so the fixture's own text has to be word-shaped.
    expect(new Set(first?.statement.split(' ')).size).toBeGreaterThan(4);
  });

  /*
   * The other half of fidelity, and the half the field sweep above cannot see: a body carrying every
   * field it declares, each holding `x`, passes that test and measures the row count precisely and the
   * byte count not at all. Every read in this budget pays for the whole `jsonb` body.
   *
   * Shape rather than a list of field names, so it keeps working as records gain fields. A string a
   * fixture writes is either something whose width the app's own shape decides — an identifier, an
   * email address, a URL, an enumerated value — or it is something a person typed, and a person types
   * sentences. `MIN_PROSE` is the app's floor for the latter at 20 characters; this holds the fixtures
   * to five times it, because the floor is what a validator will accept and not what a reader writes,
   * and a fixture at the floor would understate every one of these reads.
   */
  it('gives every prose field the width a person gives it, whatever the record declares', () => {
    const decided = [
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, // an id the app minted
      /^sha256:[0-9a-f]+$/, // a measurement fingerprint, from the app's own `fingerprintOf`
      /^[\w.-]+@[\w.-]+$/, // a Databricks identity
      /^https?:\/\//, // evidence somebody linked
      /^[a-z][a-z0-9-]*$/, // an enumerated value: a lever, a state, a residual, an effort
      /^[A-Z]+-\d{3}-[a-z]+$/, // a requirement id
      /^(assessment|plan)-\d+$/, // a definition or plan id
      /^\d+$/, // a workspace id
    ];

    // Two fields are prose in neither direction: what somebody called an assessment, and what they
    // called a plan. A title is a phrase however carefully it is chosen, so holding it to the prose
    // floor would fail a faithful fixture — and exempting it entirely would let the phrase become `x`.
    // Named rather than matched by shape, because a short string and thinned prose look identical, and
    // a prose field added later should land in the strict branch below and fail there.
    const labels = new Set(['title', 'name']);

    const thin: string[] = [];
    for (const subject of SUBJECTS) {
      for (const body of subject.bodies) {
        for (const [field, value] of strings(body)) {
          if (decided.some((shape) => shape.test(value))) continue;
          const words = new Set(value.split(' ')).size;
          const label = labels.has(field.split('.').at(-1) ?? field);
          if (label ? value.length >= 12 && words > 1 : value.length >= 5 * MIN_PROSE && words > 4) continue;
          thin.push(`${subject.type}.${field} = ${JSON.stringify(value.slice(0, 40))}`);
        }
      }
    }

    expect(thin, 'fixture strings that are neither an identifier nor prose a person wrote').toEqual([]);
  });

  it('gives each revision the history it had accrued, which is what makes a body grow', () => {
    const revisions = actions('plan-1', ['SEC-001-access'], 5, 1);
    expect(revisions.map((action) => action.history.length)).toEqual([0, 1, 2, 3, 4]);
    expect(revisions.map((action) => action.revision)).toEqual([0, 1, 2, 3, 4]);
  });

  it('names requirements in the catalogue\u2019s own shape, so a control id is the width it really is', () => {
    const ids = requirementIds(20);
    expect(new Set(ids).size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[A-Z]+-\d{3}-[a-z]+$/);
  });
});
