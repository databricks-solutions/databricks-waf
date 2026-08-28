import { describe, expect, it } from 'vitest';
import {
  classOf,
  composition,
  describeComposition,
  EVIDENCE_CLASSES,
  mayDecideOver,
  present,
} from './evidence-class.js';
import type { EvidenceClass } from './evidence-class.js';
import type { Evidence, Finding } from './finding.js';

const COLLECTED_AT = new Date('2026-08-01T00:00:00Z');

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    signal: 'sql:cost.tags',
    observed: '4 of 4',
    coverage: { mode: 'complete' },
    collectedAt: COLLECTED_AT,
    ...over,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    controlId: 'CO-01-01',
    pillarId: 'cost-optimization',
    principleId: 'CO-01',
    title: 'A control',
    outcome: 'pass',
    severity: 'medium',
    coverage: { mode: 'complete' },
    evidence: [evidence()],
    ...over,
  };
}

function answered(bearing: 'outcome' | 'record' = 'outcome'): Finding['attested'] {
  return {
    bearing,
    by: 'admin@example.com',
    at: COLLECTED_AT,
    statement: 'Rehearsed each quarter and minuted in the runbook.',
    owner: 'platform-team@example.com',
    reviewBy: new Date('2027-02-01T00:00:00Z'),
  };
}

describe('which class may decide over which', () => {
  it('lets an observation replace an answer', () => {
    expect(mayDecideOver('observed', 'attested')).toBe(true);
  });

  it('never lets an answer replace an observation', () => {
    // The property the whole design rests on. A finding an estate could improve by answering a
    // question about itself is not an assessment, and this is the direction that stops it.
    expect(mayDecideOver('attested', 'observed')).toBe(false);
  });

  it('places an imported reading between the two, in both directions', () => {
    expect(mayDecideOver('observed', 'admin-collected')).toBe(true);
    expect(mayDecideOver('admin-collected', 'attested')).toBe(true);
    expect(mayDecideOver('admin-collected', 'observed')).toBe(false);
    expect(mayDecideOver('attested', 'admin-collected')).toBe(false);
  });

  it('does not let a class replace itself, so a second reading is evidence rather than an overwrite', () => {
    for (const kind of EVIDENCE_CLASSES) {
      expect(mayDecideOver(kind, kind)).toBe(false);
    }
  });

  it('is a strict order, so no pair decides over each other', () => {
    // Stated as a property rather than as four cases, because the failure it prevents is a fourth
    // class being added with a rank that ties an existing one — at which point two claims would each
    // be entitled to replace the other and resolution would depend on arrival order.
    for (const left of EVIDENCE_CLASSES) {
      for (const right of EVIDENCE_CLASSES) {
        expect(mayDecideOver(left, right) && mayDecideOver(right, left)).toBe(false);
      }
    }
  });
});

describe('the class a finding rests on', () => {
  it('is observed for evidence that does not say, because that is what every collector produces', () => {
    expect(classOf(finding())).toBe('observed');
  });

  it('is attested when an answer decided the outcome', () => {
    expect(classOf(finding({ evidence: [], attested: answered() }))).toBe('attested');
  });

  it('is attested even where an observation is attached, because the answer is what decided it', () => {
    // A resolver that had an observation it could reach a verdict from would not have consulted the
    // answer at all — so an attested outcome means the observation beside it did not settle the
    // question, and calling the finding observed would credit it with a measurement it does not have.
    expect(classOf(finding({ attested: answered() }))).toBe('attested');
  });

  it('is not attested when the answer is only recorded beside a measurement', () => {
    expect(classOf(finding({ attested: answered('record') }))).toBe('observed');
  });

  it('is the weakest bearing class where several bear on the outcome', () => {
    const mixed = finding({
      evidence: [evidence(), evidence({ evidenceClass: 'admin-collected' })],
    });

    // Describing this as observed would describe the finding by its best part. The verdict needed
    // both, so it is only as good as the import.
    expect(classOf(mixed)).toBe('admin-collected');
  });

  it('ignores evidence that only locates what the outcome already said', () => {
    const located = finding({
      evidence: [evidence(), evidence({ evidenceClass: 'admin-collected', bearing: 'detail' })],
    });

    expect(classOf(located)).toBe('observed');
  });

  it('is undefined for a finding with nothing bearing on it', () => {
    // Honest rather than convenient: an unmeasurable requirement has no class of evidence behind it,
    // and defaulting it to observed would put it in the measured count of a score it is not in.
    expect(classOf(finding({ outcome: 'unmeasurable', evidence: [] }))).toBeUndefined();
    expect(classOf(finding({ evidence: [evidence({ bearing: 'detail' })] }))).toBeUndefined();
  });
});

describe('the composition of a set', () => {
  it('carries every class, including the ones at zero', () => {
    // So a consumer renders the mixture without deciding what an absent key meant.
    expect(composition([finding()])).toEqual({ observed: 1, 'admin-collected': 0, attested: 0 });
  });

  it('counts each finding once, under the class it rests on', () => {
    const found = composition([
      finding(),
      finding(),
      finding({ attested: answered() }),
      finding({ evidence: [evidence({ evidenceClass: 'admin-collected' })] }),
    ]);

    expect(found).toEqual({ observed: 2, 'admin-collected': 1, attested: 1 });
  });

  it('leaves out findings that rest on nothing, so the total is what the set rests on', () => {
    const found = composition([finding(), finding({ outcome: 'unmeasurable', evidence: [] })]);

    expect(found.observed + found['admin-collected'] + found.attested).toBe(1);
  });

  it('is all zero for no findings', () => {
    expect(composition([])).toEqual({ observed: 0, 'admin-collected': 0, attested: 0 });
  });
});

describe('what a reader is told about it', () => {
  const mixture = (over: Partial<Record<EvidenceClass, number>>): Record<EvidenceClass, number> => ({
    observed: 0,
    'admin-collected': 0,
    attested: 0,
    ...over,
  });

  it('lists only the classes present, strongest first', () => {
    expect(present(mixture({ observed: 3, attested: 1 }))).toEqual(['observed', 'attested']);
  });

  it('says nothing when everything was measured here', () => {
    // "18 of 18 measured" is a fact the reader takes from the absence of a caveat, and a line that
    // appears on every screen stops being read.
    expect(describeComposition(mixture({ observed: 18 }), 18)).toBe('');
  });

  it('still speaks when everything rests on one class that is not a measurement', () => {
    // The uniform case is the one that most needs saying. A score composed entirely of imported
    // readings, or entirely of answers, printed with no caveat, reads as one this app measured.
    expect(describeComposition(mixture({ 'admin-collected': 18 }), 18)).toContain(
      '18 came from a reading an administrator ran and imported'
    );
    expect(describeComposition(mixture({ attested: 6 }), 6)).toContain('6 rest on an answer somebody gave');
  });

  it('states the mixture in requirements the reader can check', () => {
    const sentence = describeComposition(mixture({ observed: 14, attested: 4 }), 18);

    expect(sentence).toContain('Of the 18 requirements in this score');
    expect(sentence).toContain('14 were measured by this app');
    expect(sentence).toContain('4 rest on an answer somebody gave');
  });

  it('names an imported reading as neither measured here nor answered', () => {
    const sentence = describeComposition(mixture({ observed: 9, 'admin-collected': 3 }), 12);

    expect(sentence).toContain('an administrator ran and imported');
  });

  it('says nothing about a score with nothing in it', () => {
    expect(describeComposition(mixture({ observed: 2, attested: 1 }), 0)).toBe('');
  });
});
