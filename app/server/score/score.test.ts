import { describe, expect, it } from 'vitest';
import type { Finding, Outcome, Severity } from '../resolve/finding.js';
import { pillarsEmptiedByDecision, scoreFindings } from './score.js';

let sequence = 0;

function unmeasured(pillarId: string, kind: Finding['unmeasured']): Finding {
  return { ...finding(pillarId, 'unmeasurable'), ...(kind != null ? { unmeasured: kind } : {}) };
}

function finding(pillarId: string, outcome: Outcome, severity: Severity = 'medium', controlId?: string): Finding {
  sequence += 1;
  return {
    controlId: controlId ?? `X-01-${String(sequence).padStart(2, '0')}`,
    pillarId,
    principleId: `${pillarId}-01`,
    title: 'A control',
    severity,
    outcome,
    coverage: { mode: 'complete' },
    // One reading, because that is what a resolver that reached a verdict produces, and the
    // composition of a score is derived from what its findings rest on.
    evidence: [
      { signal: 'sql:cost.tags', observed: '4 of 4', coverage: { mode: 'complete' }, collectedAt: new Date(0) },
    ],
  };
}

describe('scoring', () => {
  it('scores a clean pillar at 100 and a failed one at 0', () => {
    const score = scoreFindings([finding('cost', 'pass'), finding('governance', 'fail')]);
    expect(score.pillars.find((pillar) => pillar.pillarId === 'cost')?.score).toBe(100);
    expect(score.pillars.find((pillar) => pillar.pillarId === 'governance')?.score).toBe(0);
    expect(score.overall).toBe(50);
  });

  it('gives partial half credit, so progress moves the number', () => {
    expect(scoreFindings([finding('cost', 'partial')]).overall).toBe(50);
  });

  it('counts satisfied-by-architecture as a pass', () => {
    // The estate has achieved the control's intent through the platform rather than
    // through configuration. Anything else would penalise it for being modern.
    expect(scoreFindings([finding('cost', 'satisfied-by-architecture')]).overall).toBe(100);
  });

  it('weights a critical failure more heavily than a low one', () => {
    const criticalFails = scoreFindings([finding('cost', 'fail', 'critical'), finding('cost', 'pass', 'low')]);
    const lowFails = scoreFindings([finding('cost', 'pass', 'critical'), finding('cost', 'fail', 'low')]);
    expect(criticalFails.overall).toBeLessThan(lowFails.overall ?? 0);
  });

  it('does not let a large pillar swamp a small one', () => {
    // Security carries 70 controls and governance 13. A single estate-wide average
    // would make the governance result almost invisible, so the overall figure is the
    // mean of the pillar scores rather than of the controls.
    const security = Array.from({ length: 70 }, () => finding('security', 'pass'));
    const governance = [finding('governance', 'fail')];
    expect(scoreFindings([...security, ...governance]).overall).toBe(50);
  });

  it('leaves unmeasurable out of the score but visible in the counts', () => {
    // Scoring it as a failure would mean the tool's own blind spots lower the
    // customer's score, which rewards configuring the tool to see less.
    const score = scoreFindings([finding('cost', 'pass'), finding('cost', 'unmeasurable')]);
    const cost = score.pillars[0];
    expect(cost?.score).toBe(100);
    expect(cost?.scored).toBe(1);
    expect(cost?.unmeasurable).toBe(1);
    expect(cost?.total).toBe(2);
  });

  it('leaves not-applicable out of the score and names the smaller denominator', () => {
    const score = scoreFindings([finding('cost', 'fail'), finding('cost', 'not-applicable')]);
    expect(score.pillars[0]?.scored).toBe(1);
    expect(score.pillars[0]?.notApplicable).toBe(1);
  });

  it('reports no score for a pillar in which nothing could be measured', () => {
    // Zero would be a claim about the estate. Absent is a claim about the evidence.
    const score = scoreFindings([finding('cost', 'unmeasurable')]);
    expect(score.pillars[0]?.score).toBeUndefined();
    expect(score.overall).toBeUndefined();
  });
});

describe('alias groups', () => {
  const aliasGroupOf = (controlId: string) => (controlId.startsWith('SAME-') ? 'shared' : undefined);

  it('scores one requirement once however many controls express it', () => {
    const findings = [
      finding('cost', 'fail', 'high', 'SAME-01-01'),
      finding('reliability', 'fail', 'high', 'SAME-01-02'),
      finding('cost', 'pass', 'high'),
    ];

    // Without dedupe the shared failure is counted twice and drags both pillars down
    // for one thing being wrong.
    const deduped = scoreFindings(findings, { aliasGroupOf });
    expect(deduped.scoredControls).toBe(2);
  });

  it('keeps the worst outcome as the representative', () => {
    // If the same requirement reads as failing from one pillar and passing from
    // another, the failure is the true state and the pass is the less complete view.
    const score = scoreFindings(
      [finding('cost', 'pass', 'high', 'SAME-01-01'), finding('reliability', 'fail', 'high', 'SAME-01-02')],
      { aliasGroupOf }
    );
    expect(score.scoredControls).toBe(1);
    expect(score.overall).toBe(0);
  });

  it('lets a pillar keep its own not-applicable against the group, in both directions', () => {
    // A verdict is shared and applicability is local. `pass` and `fail` are readings of one
    // requirement, so the worst of them is the honest one everywhere it appears; `not-applicable` is a
    // precondition saying there is nothing here to read, evaluated per control against the estate that
    // control describes. The group may not overrule it.
    //
    // Both directions, because the override was wrong in both. Penalised: the pillar scored 0 for a
    // requirement it had excluded. Credited: with a passing sibling it scored 100 — full marks on a
    // requirement its own report shows as not applicable.
    const penalised = scoreFindings(
      [
        finding('cost', 'not-applicable', 'high', 'SAME-01-01'),
        finding('reliability', 'fail', 'high', 'SAME-01-02'),
      ],
      { aliasGroupOf }
    );
    expect(penalised.pillars.find((pillar) => pillar.pillarId === 'cost')?.score).toBeUndefined();
    expect(penalised.pillars.find((pillar) => pillar.pillarId === 'reliability')?.score).toBe(0);

    const credited = scoreFindings(
      [
        finding('cost', 'not-applicable', 'high', 'SAME-01-01'),
        finding('reliability', 'pass', 'high', 'SAME-01-02'),
      ],
      { aliasGroupOf }
    );
    expect(credited.pillars.find((pillar) => pillar.pillarId === 'cost')?.score).toBeUndefined();
    expect(credited.pillars.find((pillar) => pillar.pillarId === 'reliability')?.score).toBe(100);
  });

  it('still reports the requirement in every pillar that expresses it', () => {
    // Scoring dedupes; reporting must not, or the second pillar's report has a hole
    // where a requirement used to be.
    const score = scoreFindings(
      [finding('cost', 'fail', 'high', 'SAME-01-01'), finding('reliability', 'fail', 'high', 'SAME-01-02')],
      { aliasGroupOf }
    );
    expect(score.pillars.map((pillar) => pillar.total)).toEqual([1, 1]);
  });

  it('scores the shared requirement in every pillar that expresses it, not just one', () => {
    // The bug this replaces: the global dedupe kept one finding per group, and the pillar
    // that happened to hold it was decided by the order the catalogue files load. Measured
    // on labs, reliability scored 0 from one control while reporting four measured outcomes,
    // because three of them had been credited to cost optimization instead.
    const score = scoreFindings(
      [
        finding('cost', 'pass', 'high', 'A-01-01'),
        finding('cost', 'fail', 'high', 'SAME-01-01'),
        finding('reliability', 'fail', 'high', 'SAME-01-02'),
      ],
      { aliasGroupOf }
    );

    const reliability = score.pillars.find((pillar) => pillar.pillarId === 'reliability');
    expect(reliability?.scored).toBe(1);
    expect(reliability?.score).toBe(0);

    const cost = score.pillars.find((pillar) => pillar.pillarId === 'cost');
    expect(cost?.scored).toBe(2);
    expect(cost?.score).toBe(50);
  });

  it('does not let a pillar score above the failures it reports', () => {
    // Performance efficiency scored 100 on labs while listing two failures, both of which
    // were shared requirements credited to another pillar. A score that contradicts the list
    // beneath it is worse than a low one.
    const score = scoreFindings(
      [
        finding('cost', 'fail', 'high', 'SAME-01-01'),
        finding('performance', 'fail', 'high', 'SAME-01-02'),
        finding('performance', 'pass', 'high', 'P-01-01'),
      ],
      { aliasGroupOf }
    );

    expect(score.pillars.find((pillar) => pillar.pillarId === 'performance')?.score).toBe(50);
  });

  it('scores a requirement once when one pillar expresses it twice', () => {
    // Two controls in the same pillar sharing a group is a real catalogue shape — governance
    // states "governed by Unity Catalog" from two principles. Counting it twice would weight
    // the pillar by how many times the catalogue says the same thing.
    const score = scoreFindings(
      [finding('governance', 'fail', 'high', 'SAME-01-01'), finding('governance', 'fail', 'high', 'SAME-01-02')],
      { aliasGroupOf }
    );

    expect(score.pillars[0]?.scored).toBe(1);
    expect(score.pillars[0]?.total).toBe(2);
  });

  it('applies the group outcome to the unmeasured remainder as well as the score', () => {
    // Otherwise a shared requirement nobody could read widens one pillar's range and
    // silently narrows the other's, which overstates how much of it was assessed.
    const score = scoreFindings(
      [
        finding('cost', 'unmeasurable', 'high', 'SAME-01-01'),
        finding('reliability', 'unmeasurable', 'high', 'SAME-01-02'),
        finding('reliability', 'pass', 'high', 'R-01-01'),
      ],
      { aliasGroupOf }
    );

    const reliability = score.pillars.find((pillar) => pillar.pillarId === 'reliability');
    expect(reliability?.score).toBe(100);
    // Half the pillar's weight is unread, so the range has to say the score could be half.
    expect(reliability?.range).toEqual({ low: 50, high: 100 });
  });
});

describe('remediation ordering', () => {
  it('puts failures before partials and higher severity first', () => {
    const score = scoreFindings([
      finding('cost', 'partial', 'critical', 'B-01-01'),
      finding('cost', 'fail', 'low', 'C-01-01'),
      finding('cost', 'fail', 'critical', 'A-01-01'),
      finding('cost', 'pass', 'critical', 'D-01-01'),
    ]);
    expect(score.pillars[0]?.worstFirst.map((item) => item.controlId)).toEqual(['A-01-01', 'C-01-01', 'B-01-01']);
  });
});

describe('the range around a score', () => {
  const pillarOf = (score: ReturnType<typeof scoreFindings>, id: string) =>
    score.pillars.find((pillar) => pillar.pillarId === id);

  it('collapses to the score itself when everything was measured', () => {
    const score = scoreFindings([finding('cost', 'pass'), finding('cost', 'fail')]);

    const cost = pillarOf(score, 'cost');
    expect(cost?.score).toBe(50);
    expect(cost?.range).toEqual({ low: 50, high: 50 });
  });

  it('opens wide when the score rests on almost nothing', () => {
    // The case that prompted this: security scored 50 from one partial requirement of 70,
    // and 50 read as a verdict on the pillar rather than on the one thing that was read.
    const findings = [finding('security', 'partial'), ...Array.from({ length: 69 }, () => finding('security', 'unmeasurable'))];

    const security = pillarOf(scoreFindings(findings), 'security');

    expect(security?.score).toBe(50);
    expect(security?.range?.low).toBeLessThan(2);
    expect(security?.range?.high).toBeGreaterThan(98);
    // The width is the unmeasured share, so 69 of 70 equal-weight requirements unread.
    expect((security?.range?.high ?? 0) - (security?.range?.low ?? 0)).toBeCloseTo((69 / 70) * 100, 1);
  });

  it('stops a 100 from claiming a pillar it barely looked at', () => {
    // Performance efficiency scored 100 live, from 5 of 24 applicable requirements.
    const findings = [
      ...Array.from({ length: 5 }, () => finding('performance', 'pass')),
      ...Array.from({ length: 17 }, () => finding('performance', 'unmeasurable')),
    ];

    const performance = pillarOf(scoreFindings(findings), 'performance');

    expect(performance?.score).toBe(100);
    // Every unmeasured requirement failing would take it to 5/22.
    expect(performance?.range).toEqual({ low: 22.7, high: 100 });
  });

  it('stops a 0 from condemning a pillar it barely looked at', () => {
    // Reliability scored 0 live, from a single failing requirement of 16.
    const findings = [finding('reliability', 'fail'), ...Array.from({ length: 13 }, () => finding('reliability', 'unmeasurable'))];

    const reliability = pillarOf(scoreFindings(findings), 'reliability');

    expect(reliability?.score).toBe(0);
    expect(reliability?.range).toEqual({ low: 0, high: 92.9 });
  });

  it('does not widen the range for requirements that do not apply', () => {
    // A control that does not apply to this estate is not a gap in knowledge. Measuring it
    // would change nothing, so it must not make the score look less certain than it is.
    const findings = [finding('cost', 'pass'), ...Array.from({ length: 20 }, () => finding('cost', 'not-applicable'))];

    expect(pillarOf(scoreFindings(findings), 'cost')?.range).toEqual({ low: 100, high: 100 });
  });

  it('widens the range more for a critical unknown than an informational one', () => {
    const critical = scoreFindings([finding('cost', 'pass'), finding('cost', 'unmeasurable', 'critical')]);
    const informational = scoreFindings([finding('cost', 'pass'), finding('cost', 'unmeasurable', 'informational')]);

    const width = (score: ReturnType<typeof scoreFindings>): number => {
      const range = pillarOf(score, 'cost')?.range;
      return (range?.high ?? 0) - (range?.low ?? 0);
    };

    expect(width(critical)).toBeGreaterThan(width(informational));
  });

  it('gives no range where there is no score', () => {
    const security = pillarOf(scoreFindings([finding('security', 'unmeasurable')]), 'security');

    expect(security?.score).toBeUndefined();
    expect(security?.range).toBeUndefined();
  });

  it('carries the range up to the overall without weighting the mean', () => {
    // Weighting the mean toward better-measured pillars would raise the score of an estate
    // the tool can see less of, which is the incentive the whole model exists to avoid.
    const findings = [
      finding('cost', 'pass'),
      finding('reliability', 'fail'),
      ...Array.from({ length: 13 }, () => finding('reliability', 'unmeasurable')),
    ];

    const score = scoreFindings(findings);

    // Still the plain mean of 100 and 0, not pulled up by reliability being unreadable.
    expect(score.overall).toBe(50);
    expect(score.range).toEqual({ low: 50, high: 96.5 });
  });
});

describe('splitting what is unknown by what would answer it', () => {
  const splitOf = (findings: readonly Finding[], id: string) =>
    scoreFindings(findings).pillars.find((pillar) => pillar.pillarId === id)?.unmeasuredBy;

  it('separates a practice statement from a source it could not read', () => {
    // Live reliability: 12 practice statements plus one unreadable source read as a broken
    // assessment when reported as a single count of 13.
    const findings = [
      finding('reliability', 'fail'),
      ...Array.from({ length: 12 }, () => unmeasured('reliability', 'attestation')),
      unmeasured('reliability', 'unreadable'),
    ];

    expect(splitOf(findings, 'reliability')).toEqual({
      attestation: 12,
      unreachable: 0,
      unbuilt: 0,
      unreadable: 1,
      disabled: 0,
    });
  });

  it('adds up to the pillar\'s own unmeasured count, so the two cannot disagree', () => {
    const findings = [
      unmeasured('cost', 'attestation'),
      unmeasured('cost', 'unbuilt'),
      unmeasured('cost', 'unreadable'),
      finding('cost', 'pass'),
    ];

    const pillar = scoreFindings(findings).pillars.find((entry) => entry.pillarId === 'cost');
    const split = pillar?.unmeasuredBy;

    expect((split?.attestation ?? 0) + (split?.unbuilt ?? 0) + (split?.unreadable ?? 0)).toBe(pillar?.unmeasurable);
  });

  it('counts a check the customer switched off as disabled, not as a source it could not read', () => {
    // The default below is why this kind exists. Without it a customer-disabled check falls to
    // `unreadable`, and the export and the report appendix then say the app asked and got no answer
    // about a check it was told not to run. Row 31b produces these, so the kind lands before it.
    expect(splitOf([unmeasured('cost', 'disabled')], 'cost')).toEqual({
      attestation: 0,
      unreachable: 0,
      unbuilt: 0,
      unreadable: 0,
      disabled: 1,
    });
  });

  it('counts an unlabelled unknown as unreadable, never as the customer\'s to answer', () => {
    // A stored scan from before this field existed has none. Reading it as an outstanding
    // attestation would ask the customer to confirm something nobody claimed they should.
    expect(splitOf([unmeasured('cost', undefined)], 'cost')).toEqual({
      attestation: 0,
      unreachable: 0,
      unbuilt: 0,
      unreadable: 1,
      disabled: 0,
    });
  });

  it('counts nothing for a pillar with everything measured', () => {
    expect(splitOf([finding('cost', 'pass')], 'cost')).toEqual({
      attestation: 0,
      unreachable: 0,
      unbuilt: 0,
      unreadable: 0,
      disabled: 0,
    });
  });

  it('does not count requirements that do not apply, which are not unknown', () => {
    expect(splitOf([finding('cost', 'pass'), finding('cost', 'not-applicable')], 'cost')).toEqual({
      attestation: 0,
      unreachable: 0,
      unbuilt: 0,
      unreadable: 0,
      disabled: 0,
    });
  });
});

describe('how much of a score rests on an answer rather than a measurement', () => {
  const attested = (pillarId: string, outcome: Outcome, bearing: 'outcome' | 'record' = 'outcome'): Finding => ({
    ...finding(pillarId, outcome),
    attested: {
      bearing,
      by: 'admin@example.com',
      at: new Date('2026-06-01T00:00:00Z'),
      statement: 'Rehearsed each quarter and minuted in the runbook.',
      owner: 'platform-team@example.com',
      reviewBy: new Date('2026-12-01T00:00:00Z'),
    },
  });

  it('counts the attested requirements in a pillar', () => {
    // Without this figure, an organisation could raise its score by answering questions about
    // itself and no reader could tell. A pillar at 80 with two of twenty attested is an
    // assessment; the same 80 with eighteen attested is a questionnaire.
    const score = scoreFindings([attested('operations', 'pass'), finding('operations', 'pass')]);

    expect(score.pillars[0]?.composition.attested).toBe(1);
    expect(score.pillars[0]?.composition.observed).toBe(1);
    expect(score.pillars[0]?.scored).toBe(2);
  });

  it('counts an answer recorded beside a measurement as measured, because the measurement decided it', () => {
    const score = scoreFindings([attested('operations', 'fail', 'record')]);

    expect(score.pillars[0]?.composition).toEqual({ observed: 1, 'admin-collected': 0, attested: 0 });
  });

  it('counts nothing attested where nothing was answered', () => {
    expect(scoreFindings([finding('operations', 'pass')]).pillars[0]?.composition.attested).toBe(0);
  });

  it('reports the total across the assessment as well as per pillar', () => {
    const score = scoreFindings([attested('operations', 'pass'), attested('interoperability', 'partial'), finding('cost', 'pass')]);

    expect(score.composition).toEqual({ observed: 1, 'admin-collected': 0, attested: 2 });
    expect(score.scoredControls).toBe(3);
  });

  it('does not count an attested requirement that left the denominator', () => {
    // Attested as not applicable is not part of the score, so counting it among the score's
    // attested share would report a fraction of a set it is not in.
    const score = scoreFindings([attested('operations', 'not-applicable'), finding('operations', 'pass')]);

    expect(score.pillars[0]?.composition.attested).toBe(0);
    expect(score.composition.attested).toBe(0);
  });

});

/*
 * What it is worth to a customer to stop a requirement being measured.
 *
 * Here because row 31b is about to let a customer do exactly that, and both `d1-methodology.md` and
 * ADR 0059 said disabling a check widens "the range without improving the figure, so it cannot be
 * used to score better, only to be measured less". That sentence is a claim about this function, and
 * it is wrong: `CREDIT` maps both `unmeasurable` and `not-applicable` to `null`, so both leave
 * `available`, and a failing requirement contributes a zero to the average that removing it takes
 * away with it.
 *
 * Pinned as arithmetic rather than described, because the numbers are the argument. The tests below
 * are the four things the two documents got wrong, in the order they were found: that the
 * movement is a doubling, that it is a movement in the estate figure, that the range is what makes
 * disabling the safer lever, and that the two levers act on one pillar at a time.
 */
describe('what stopping a measurement is worth to the score', () => {
  it('shows a better score when a failing requirement stops being measured, either way', () => {
    const reading = (outcome: Outcome) => {
      const pillar = scoreFindings([finding('operations', 'pass'), finding('operations', outcome)]).pillars[0];
      return { score: pillar?.score, low: pillar?.range?.low, high: pillar?.range?.high };
    };

    expect(reading('fail')).toEqual({ score: 50, low: 50, high: 50 });
    expect(reading('unmeasurable')).toEqual({ score: 100, low: 50, high: 100 });
    expect(reading('not-applicable')).toEqual({ score: 100, low: 100, high: 100 });
  });

  it('moves the figure by as much as the severity weighting allows, not by a fixed factor', () => {
    // The first correction said "doubles", which is what the equal-weight case above happens to do.
    // Severity is multiplicative, so the factor is a property of the pair and not of the lever: a
    // critical failure beside an informational pass is 0.5/10.5 of the weight, and switching it off
    // moves the pillar by a factor of about twenty rather than two.
    const pillarOf = (outcome: Outcome) =>
      scoreFindings([finding('operations', 'pass', 'informational'), finding('operations', outcome, 'critical')])
        .pillars[0]?.score;

    expect(pillarOf('fail')).toBe(4.8);
    expect(pillarOf('unmeasurable')).toBe(100);
  });

  it('moves the estate figure far less than the pillar, because the overall is a mean of pillars', () => {
    // Asserted on `overall` rather than on a pillar because `overall` is what `CoverageHero` renders
    // and what goes into an export. The two documents used "the headline" for a pillar score, which
    // overstates the movement by the number of pillars: one failure switched off in one pillar of
    // seven moves the pillar 50 to 100 and the estate 50 to 57.1.
    const others = ['cost', 'security', 'reliability', 'performance', 'governance', 'interoperability'].flatMap(
      (pillarId) => [finding(pillarId, 'pass'), finding(pillarId, 'fail')]
    );

    expect(scoreFindings([...others, finding('operations', 'pass'), finding('operations', 'fail')]).overall).toBe(50);
    expect(
      scoreFindings([...others, finding('operations', 'pass'), finding('operations', 'unmeasurable')]).overall
    ).toBe(57.1);
  });

  /*
   * The cliff, which is where the range stops being the safeguard the documents relied on.
   *
   * A disabled requirement keeps its weight in the pillar's `total`, so while the pillar still has
   * something scored the range opens and a reader can see how much is unknown. Disable the last
   * scored requirement and the pillar has no `score` at all, and both `overall` and the estate range
   * are means over the pillars that scored — so the pillar leaves the figure and the range together,
   * and the range closes to a point. At that boundary disabling and not-applicable are identical on
   * every number a reader is shown, which is the opposite of what "the range is what still differs"
   * claimed.
   */
  it('closes the estate range instead of opening it when a pillar loses its last scored requirement', () => {
    const healthy = ['cost', 'security', 'reliability'].flatMap((pillarId) => [
      finding(pillarId, 'pass'),
      finding(pillarId, 'pass'),
    ]);
    const estate = (outcome: Outcome) =>
      scoreFindings([...healthy, finding('governance', outcome), finding('governance', outcome)]);

    const failing = estate('fail');
    expect(failing.overall).toBe(75);
    expect(failing.range).toEqual({ low: 75, high: 75 });

    // One requirement short of the cliff the range still carries the doubt: 87.5–100.
    const partly = scoreFindings([...healthy, finding('governance', 'unmeasurable'), finding('governance', 'pass')]);
    expect(partly.overall).toBe(100);
    expect(partly.range).toEqual({ low: 87.5, high: 100 });

    // Over it, the pillar is absent from both, and the two levers agree exactly.
    const disabled = estate('unmeasurable');
    expect(disabled.pillars.find((pillar) => pillar.pillarId === 'governance')?.score).toBeUndefined();
    expect(disabled.overall).toBe(100);
    expect(disabled.range).toEqual({ low: 100, high: 100 });
    expect(estate('not-applicable').range).toEqual(disabled.range);
  });
});

describe('what stopping a measurement is worth across an alias group', () => {
  const aliasGroupOf = (controlId: string) => (controlId.startsWith('SAME-') ? 'shared' : undefined);

  /*
   * Disabling one member of an alias group changes the other pillar's reading of it.
   *
   * `worstInGroup` gives every pillar expressing a requirement the group's worst outcome, and
   * `SEVERITY_OF_OUTCOME` ranks `unmeasurable` worse than `pass`. So switching a check off in one
   * pillar converts a *passing* member of the same group in another pillar to unmeasurable, which is
   * the one case where the lever reaches a pillar the customer did not touch. Thirty-one controls in
   * the shipped catalogue carry an `alias_group`, so this is the estate's arrangement rather than a
   * constructed one.
   *
   * The measurement behind ADR 0059's second amendment passed no `aliasGroupOf`, so it could not see
   * this, and the movement here is the largest of any case in that amendment: 25 to 100.
   */
  it('converts a passing member in another pillar to unmeasurable, and takes that pillar out of the mean', () => {
    const withOperations = (outcome: Outcome) =>
      scoreFindings(
        [
          finding('operations', outcome, 'medium', 'SAME-01-01'),
          finding('security', 'pass', 'medium', 'SAME-01-02'),
          finding('operations', 'pass'),
        ],
        { aliasGroupOf }
      );

    const failing = withOperations('fail');
    expect(failing.pillars.map((pillar) => [pillar.pillarId, pillar.score])).toEqual([
      ['operations', 50],
      ['security', 0],
    ]);
    expect(failing.overall).toBe(25);

    const disabled = withOperations('unmeasurable');
    const security = disabled.pillars.find((pillar) => pillar.pillarId === 'security');

    // Security expressed one requirement and it passed. Nobody disabled anything in security, and
    // nothing the pillar carries says otherwise: it reports one requirement, met, no score, and
    // nothing unmeasured. So this pillar's own counts hold no trace of the reason it left the mean,
    // which is the condition under which the exposure the second rule relies on cannot be written.
    expect(security?.score).toBeUndefined();
    expect(security?.counts).toMatchObject({ pass: 1, unmeasurable: 0 });
    expect(security?.total).toBe(1);
    expect(security?.scored).toBe(0);
    expect(security?.unmeasurable).toBe(0);

    expect(disabled.overall).toBe(100);
    expect(disabled.range).toEqual({ low: 50, high: 100 });
  });
});

describe('pillars a decision emptied', () => {
  it('counts a pillar whose last scored requirement was set aside', () => {
    // The reason this number exists: the pillar leaves the mean, the estate number moves, and no
    // arithmetic goes wrong. 31c measured 75 with a range of 75–75 becoming 100 with a range of 100–100.
    const kept = finding('cost', 'pass');
    const removed = finding('reliability', 'fail');
    const before = [kept, removed];
    const after = [kept, { ...removed, outcome: 'not-applicable' as const }];

    expect(pillarsEmptiedByDecision(before, after)).toBe(1);
    expect(scoreFindings(before).overall).toBe(50);
    expect(scoreFindings(after).overall).toBe(100);
  });

  it('counts nothing when the pillar still has a scored requirement', () => {
    const removed = finding('cost', 'fail');
    const before = [removed, finding('cost', 'pass')];
    const after = [{ ...removed, outcome: 'not-applicable' as const }, before[1]];

    expect(pillarsEmptiedByDecision(before, after)).toBe(0);
  });

  it('counts nothing for a pillar that had no score to lose', () => {
    // An unmeasurable pillar is already out of the mean, so a decision over it did not empty anything.
    const removed = finding('reliability', 'unmeasurable');
    const before = [finding('cost', 'pass'), removed];
    const after = [before[0], { ...removed, outcome: 'not-applicable' as const }];

    expect(pillarsEmptiedByDecision(before, after)).toBe(0);
  });

  it('scores both sides the same way, so an alias group cannot make it over-report', () => {
    // The requirement reads `pass` in reliability and `unmeasurable` in cost, and the group's worst
    // reading is what scores — so reliability was already out of the mean and had no score to lose.
    // Counting credit-bearing outcomes instead of scoring would have called this an emptied pillar.
    const shared = finding('reliability', 'pass', 'medium', 'SHARED-01-01');
    const sibling = finding('cost', 'unmeasurable', 'medium', 'SHARED-01-02');
    const aliasGroupOf = (controlId: string) => (controlId.startsWith('SHARED') ? 'shared' : undefined);
    const before = [shared, sibling];
    const after = [{ ...shared, outcome: 'not-applicable' as const }, sibling];

    expect(pillarsEmptiedByDecision(before, after, { aliasGroupOf })).toBe(0);
  });
});
