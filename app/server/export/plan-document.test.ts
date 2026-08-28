// What a plan looks like once it has left the app.
//
// The tests worth having here are the ones about properties a reader cannot check for themselves. That
// the CSV has the right columns is visible in `PLAN_VARIANT_SHAPES`; that two exports of one plan are
// the same bytes is not visible anywhere, and it is the property everything else rests on.

import { describe, expect, it } from 'vitest';
import type { ImprovementAction, Transition } from '../improve/action.js';
import type { ImprovementPlan } from '../improve/plan.js';
import type { ActionProgress, PlanProgress } from '../improve/progress.js';
import { planProgress, progressOf } from '../improve/progress.js';
import { sealPlan } from './artefact.js';
import {
  DEFAULT_PLAN_VARIANT,
  PLAN_VARIANTS,
  planCsv,
  planDocument,
  planExportName,
  planVariantOf,
  type PlanExportOptions,
} from './plan-document.js';

const TITLES: Readonly<Record<string, string>> = {
  'SEC-01-02': 'Every workspace has a cluster policy',
  'REL-02-04': 'Critical tables carry constraints',
};

function plan(over: Partial<ImprovementPlan> = {}): ImprovementPlan {
  return {
    id: 'plan-1234-5678',
    title: 'Close the security gaps from the March run',
    outcome: 'No workspace in production runs without a cluster policy, and the run agrees.',
    owners: ['platform-team', 'priya@example.com'],
    raisedFrom: 'run-9999',
    assessment: { definitionId: 'def-1', version: 2 },
    createdBy: 'priya@example.com',
    createdAt: new Date('2026-03-04T09:00:00Z'),
    revision: 3,
    ...over,
  };
}

function action(over: Partial<ImprovementAction> = {}): ImprovementAction {
  return {
    id: 'action-1',
    planId: 'plan-1234-5678',
    controlIds: ['SEC-01-02'],
    outcome: 'Production workspaces refuse a cluster without a policy attached.',
    definitionOfDone: 'Every production workspace has a policy, and a new cluster without one is refused.',
    owner: 'platform-team',
    priority: 'now',
    effort: 'medium',
    due: new Date('2026-04-01T00:00:00Z'),
    steps: ['Write the policy', 'Apply it to the four production workspaces'],
    dependsOn: [],
    state: 'in-progress',
    createdBy: 'priya@example.com',
    createdAt: new Date('2026-03-04T10:00:00Z'),
    history: [transition({ from: 'draft', to: 'planned' }), transition({ from: 'planned', to: 'in-progress' })],
    revision: 2,
    ...over,
  };
}

function transition(over: Partial<Transition> = {}): Transition {
  return {
    from: 'draft',
    to: 'planned',
    at: new Date('2026-03-05T11:00:00Z'),
    by: 'person',
    who: 'priya@example.com',
    ...over,
  };
}

function progress(over: Partial<PlanProgress> = {}): PlanProgress {
  return {
    planId: 'plan-1234-5678',
    states: {
      draft: 0,
      planned: 0,
      'in-progress': 1,
      blocked: 0,
      'ready-for-validation': 0,
      verified: 0,
      cancelled: 0,
    },
    contradicted: [],
    overdue: [],
    blocked: [],
    settled: false,
    ...over,
  };
}

function reading(over: Partial<ActionProgress> = {}): ActionProgress {
  return {
    action: action(),
    agreement: 'unclaimed',
    lateness: 'on-time',
    unmet: [],
    unreadable: [],
    ...over,
  };
}

function options(over: Partial<PlanExportOptions> = {}): PlanExportOptions {
  return {
    plan: plan(),
    actions: [reading()],
    progress: progress(),
    titleOf: (id) => TITLES[id],
    judgedAgainst: { runId: 'run-later', at: new Date('2026-03-20T08:00:00Z') },
    ...over,
  };
}

/**
 * The header and the data rows, parsed rather than split on commas.
 *
 * A plan's cells contain commas and newlines — an outcome is a sentence and the steps are a list — so
 * splitting would silently misalign every column after the first quoted one. Parsing here also means
 * these assertions exercise the quoting `csv.ts` produces rather than assuming it away.
 */
function rows(over: Partial<PlanExportOptions> = {}): { header: string[]; data: string[][] } {
  const [header = [], ...data] = parse(planCsv(options(over)));
  return { header, data };
}

/** The document's actions as records, since `planDocument` returns the loose shape a JSON file has. */
function actionsIn(from: PlanExportOptions): readonly Record<string, unknown>[] {
  return planDocument(from).actions as readonly Record<string, unknown>[];
}

function parse(text: string): string[][] {
  const table: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\r' && text[index + 1] === '\n') {
      row.push(cell);
      table.push(row);
      row = [];
      cell = '';
      index += 1;
    } else cell += character;
  }
  row.push(cell);
  table.push(row);
  return table;
}

describe('a plan as a file', () => {
  it('is the same bytes every time the same plan in the same state is exported', () => {
    // The property a published digest rests on. ADR 0050: the assessment document made the mistake in
    // version 1 with `generatedAt` and removed it in version 2.
    expect(sealPlan({ ...options(), format: 'json' }).digest).toBe(sealPlan({ ...options(), format: 'json' }).digest);
    expect(JSON.stringify(planDocument(options()))).not.toContain('generatedAt');
  });

  it('is the same bytes at any clock, because nothing it carries is measured from now', () => {
    // The one this file got wrong. Nothing in `plan-document.ts` reads a clock, but `progressOf` does:
    // an action's `lateness` is its due date against *now*, and while the export carried that column the
    // digest of an untouched plan changed the moment a due date passed. The panel would then have told a
    // sender their recipient's copy had been altered, which is the exact false alarm publishing digests
    // exists to prevent.
    //
    // Built from the real `progressOf` rather than from a hand-made reading, because a fixture cannot
    // reproduce the defect — the clock has to be the one thing that differs.
    const context = { findings: [], measuredAt: new Date('2026-03-20T08:00:00Z') };
    const before = new Date('2026-03-31T23:59:00Z');
    const after = new Date('2027-01-01T00:00:00Z');

    // That the readings genuinely differ is asserted first. Without it this test would still pass if
    // `progressOf` stopped reading the clock, and would then be guarding nothing.
    expect(progressOf(action(), { ...context, now: before }).lateness).not.toBe(
      progressOf(action(), { ...context, now: after }).lateness
    );

    const at = (now: Date): PlanExportOptions =>
      options({
        actions: [progressOf(action(), { ...context, now })],
        progress: planProgress('plan-1234-5678', [action()], { ...context, now }),
      });

    for (const format of ['csv', 'json'] as const) {
      expect(sealPlan({ ...at(before), format }).digest).toBe(sealPlan({ ...at(after), format }).digest);
    }
  });

  it('changes digest when an action moves, which is the mismatch a recipient will report', () => {
    const moved = options({ actions: [reading({ action: action({ state: 'ready-for-validation' }) })] });
    expect(sealPlan({ ...moved, format: 'json' }).digest).not.toBe(sealPlan({ ...options(), format: 'json' }).digest);
  });

  it('changes digest when a later run disagrees, without the plan itself moving', () => {
    // The second honest mismatch, and the one that surprises people: an agreement is a comparison
    // against a run, so a file can change when nobody touched the plan.
    const contradicted = options({
      actions: [reading({ agreement: 'contradicted', unmet: ['SEC-01-02'] })],
      progress: progress({ contradicted: ['action-1'] }),
    });
    expect(sealPlan({ ...contradicted, format: 'csv' }).digest).not.toBe(
      sealPlan({ ...options(), format: 'csv' }).digest
    );
  });

  it('names the plan and the variant, and carries no version even though the plan has one', () => {
    expect(planExportName(plan(), 'csv')).toBe('improvement-plan-plan-123.csv');
    expect(planExportName(plan(), 'json', 'executive')).toBe('improvement-plan-plan-123-executive.json');
    expect(planExportName(plan(), 'csv', DEFAULT_PLAN_VARIANT)).toBe('improvement-plan-plan-123.csv');
    // The same name at a different revision, which is the property `taken` needs to be able to say
    // whether a copy somebody already sent still matches. A name that changed every time would make
    // every recorded export look like one this build can no longer produce.
    expect(planExportName(plan({ revision: 9 }), 'csv')).toBe(planExportName(plan({ revision: 3 }), 'csv'));
  });

  it('gives every variant a different digest, because they are different bytes', () => {
    const digests = PLAN_VARIANTS.map((variant) => sealPlan({ ...options(), format: 'json', variant }).digest);
    expect(new Set(digests).size).toBe(PLAN_VARIANTS.length);
  });

  it('refuses a variant it does not produce rather than handing over the complete file', () => {
    expect(planVariantOf('summary')).toBeUndefined();
    expect(planVariantOf('')).toBe(DEFAULT_PLAN_VARIANT);
    expect(planVariantOf('audit')).toBe('audit');
  });
});

describe('what a variant may leave out', () => {
  it('carries every action in every variant, including the cancelled and the draft ones', () => {
    // The one rule a variant may not break. A plan document missing its cancelled actions cannot be
    // told apart from one whose author found them inconvenient.
    const three = options({
      actions: [
        reading(),
        reading({ action: action({ id: 'action-2', state: 'cancelled' }) }),
        reading({ action: action({ id: 'action-3', state: 'draft' }) }),
      ],
    });

    for (const variant of PLAN_VARIANTS) {
      const lines = planCsv({ ...three, variant }).split('\r\n');
      expect(lines).toHaveLength(4);
      const document = planDocument({ ...three, variant });
      expect((document.actions as readonly unknown[]).length).toBe(3);
    }
  });

  it('keeps the history for the audit file and nowhere else', () => {
    expect(rows({ variant: 'audit' }).header).toContain('history');
    expect(rows({ variant: 'delivery' }).header).not.toContain('history');
    expect(rows({ variant: 'executive' }).header).not.toContain('history');

    expect(actionsIn(options({ variant: 'audit' }))[0]?.history).toHaveLength(2);
    // Absent rather than empty. An empty history would read as an action nobody has moved.
    expect(actionsIn(options({ variant: 'delivery' }))[0]).not.toHaveProperty('history');
  });

  it('says which variant it is and what that means, and names the whole of it when it is a subset', () => {
    const complete = planDocument(options({ variant: 'delivery' }));
    expect(complete.variant).toBe('delivery');
    expect(complete.variantMeans).toContain('complete file');
    expect(complete.variantOmits).toBeUndefined();

    const short = planDocument(options({ variant: 'executive' }));
    expect(short.variantOmits).toContain('delivery and audit exports');
  });

  it('spells out what an agreement means, in the file rather than in the reader', () => {
    const [row] = rows({ actions: [reading({ agreement: 'contradicted', unmet: ['SEC-01-02'] })] }).data;
    expect(planCsv(options({ actions: [reading({ agreement: 'contradicted' })] }))).toContain(
      'and a later run still finds a requirement unmet'
    );
    expect(row).toBeDefined();
  });

  it('says an advisory rather than a run for the action no requirement can answer', () => {
    // The same six words in a spreadsheet cell mean two different measurements, and which one it was
    // is decided by whether the action names a requirement. An advice-raised action reading "a run
    // measured every requirement as met" would describe a measurement of nothing: it names none, and
    // no run read it. What settled it is `advice-settle.ts`, and the cell has to say so.
    const advised = [reading({ action: action({ controlIds: [] }), agreement: 'agreed' })];

    const file = planCsv(options({ actions: advised }));
    expect(file).toContain('read the resource and did not report the rule it came from');
    expect(file).not.toContain('measured every requirement as met');

    expect(actionsIn(options({ actions: advised }))[0]?.agreementMeans).toBe(
      'an advisory after it was reported done read the resource and did not report the rule it came from'
    );
  });

  it('keeps the assessment’s wording for an action that names a requirement as well as advice', () => {
    // One judge per action, decided by the requirements it names — `progress.ts` computes the agreement
    // that way, so a file wording it the other way would attribute the reading to the wrong measurement.
    expect(planCsv(options({ actions: [reading({ agreement: 'agreed' })] }))).toContain(
      'a run measured every requirement as met'
    );
  });
});

describe('what the file has to carry to be argued with', () => {
  it('names the run every agreement was judged against, and says so when there was none', () => {
    expect(planDocument(options()).judgedAgainst).toEqual({ run: 'run-later', at: '2026-03-20T08:00:00.000Z' });

    const unmeasured = planCsv(options({ judgedAgainst: undefined }));
    expect(unmeasured).toContain('no run has measured this estate');
    expect(planDocument(options({ judgedAgainst: undefined })).judgedAgainst).toBeUndefined();
  });

  it('keeps a requirement id when the catalogue no longer has a title for it', () => {
    // A row about a requirement a later catalogue version dropped still says which one it was, which is
    // what a reader of an old plan needs. `presentAction` makes the same choice.
    const { header, data } = rows({ actions: [reading({ action: action({ controlIds: ['GONE-01-01'] }) })] });
    const titles = data[0]?.[header.indexOf('requirement_titles')];
    expect(titles).toBe('GONE-01-01');
  });

  it('carries the plan on every row, so a filtered spreadsheet is still complete statements', () => {
    const { header, data } = rows({
      actions: [reading(), reading({ action: action({ id: 'action-2' }) })],
    });
    const column = header.indexOf('plan');
    expect(data.map((row) => row[column])).toEqual(['plan-1234-5678', 'plan-1234-5678']);
  });

  it('says a plan is closed, and when, rather than only that it is not open', () => {
    const shut = rows({
      plan: plan({ closed: { at: new Date('2026-05-01T00:00:00Z'), by: 'priya@example.com', reason: 'Work finished.' } }),
    });
    expect(shut.data[0]?.[shut.header.indexOf('plan_state')]).toBe('closed 2026-05-01');
    // And distinguishes a plan whose work is all terminal from one nobody has got round to closing.
    const settled = rows({ progress: progress({ settled: true }) });
    expect(settled.data[0]?.[settled.header.indexOf('plan_state')]).toBe('open, every action settled');
  });

  it('produces a row for a plan with no actions rather than a header with nothing under it', () => {
    const { header, data } = rows({ actions: [], progress: progress({ settled: true }) });
    expect(data).toHaveLength(1);
    expect(data[0]?.[header.indexOf('plan')]).toBe('plan-1234-5678');
    expect(data[0]?.[header.indexOf('action')]).toBe('');
  });

  it('defuses a value a spreadsheet would evaluate, wherever a person typed it', () => {
    // The outcome, the definition of done and the steps are all free text somebody typed, and all three
    // reach a cell. `csv.ts` does the work; this establishes that a plan's fields go through it.
    const nasty = planCsv(
      options({
        actions: [
          reading({
            action: action({
              outcome: '=cmd|calc',
              steps: ['@SUM(A1:A2)'],
            }),
          }),
        ],
        variant: 'delivery',
      })
    );
    expect(nasty).toContain("'=cmd|calc");
    expect(nasty).toContain("'@SUM(A1:A2)");
  });

  it('defuses a payload written as any step, not only the first', () => {
    // The steps cell is newline-separated, so a payload in step two was on a line of its own that the
    // old rule never looked at — and a reader who copies that cell out of the sheet turns each line into
    // a cell. The earlier test only ever put the payload at index 0, which is why it passed throughout.
    const nasty = planCsv(
      options({
        actions: [reading({ action: action({ steps: ['Write the policy', "=cmd|'/C calc'!A0"] }) })],
        variant: 'delivery',
      })
    );
    expect(nasty).toContain("'=cmd|'/C calc'!A0");
  });

  it('writes each state change as a line somebody can read down a column, naming a run as a run', () => {
    const verified = planCsv(
      options({
        variant: 'audit',
        actions: [
          reading({
            action: action({
              history: [
                transition({ from: 'in-progress', to: 'ready-for-validation' }),
                transition({ from: 'ready-for-validation', to: 'verified', by: 'run', who: 'run-later' }),
              ],
            }),
          }),
        ],
      })
    );
    // A scan id in a `who` column would otherwise read as an unfamiliar colleague, and the one move a
    // run makes is exactly the one an auditor is checking for.
    expect(verified).toContain('ready-for-validation → verified by run run-later');
  });
});
