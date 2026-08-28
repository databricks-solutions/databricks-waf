import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type Census, chainsFrom, measure, shapesFrom } from './measure-action-provenance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDING = join(HERE, 'recordings', 'action-provenance.json');

/** A contract in miniature: a run, an analysis, a resource row, and a finding on it. */
const contract = `
  export interface AdvisoryPayload {
    readonly id: string;
    readonly widgets?: WidgetPayload;
  }
  export interface WidgetPayload {
    readonly rulesVersion: number;
    readonly rankingVersion: string;
    readonly widgets: readonly WidgetRowPayload[];
  }
  export interface WidgetRowPayload {
    readonly workspaceId: string;
    readonly widgetId: string;
    readonly findings: readonly WidgetFindingPayload[];
  }
  export interface WidgetFindingPayload {
    readonly rule: string;
    readonly severity: 'high' | 'low';
    readonly headline: string;
    readonly detail: string;
    readonly docUrl: string;
    readonly evidence: readonly EvidencePayload[];
  }
  export interface EvidencePayload {
    readonly label: string;
    readonly value: number;
  }
`;

describe('the population is what a client is served, walked from the run payload', () => {
  it('reaches a finding through the analysis and the resource row that hold it', () => {
    const [chain] = chainsFrom(shapesFrom(contract));
    expect(chain?.advisor).toBe('widgets');
    expect(chain?.finding).toBe('WidgetFindingPayload');
    expect(chain?.levels.map((level) => level.property)).toEqual(['widgets', 'widgets', 'findings']);
    expect(chain?.levels.map((level) => level.repeated)).toEqual([false, true, true]);
  });

  it('does not call an object without a rule identity a finding', () => {
    const chains = chainsFrom(
      shapesFrom(`
        export interface AdvisoryPayload {
          readonly widgets?: WidgetPayload;
        }
        export interface WidgetPayload {
          readonly widgets: readonly WidgetRowPayload[];
        }
        export interface WidgetRowPayload {
          readonly widgetId: string;
          readonly headline: string;
        }
      `)
    );
    expect(chains).toEqual([]);
  });

  it('does not follow a payload that refers back to itself for ever', () => {
    const chains = chainsFrom(
      shapesFrom(`
        export interface AdvisoryPayload {
          readonly widgets?: WidgetPayload;
        }
        export interface WidgetPayload {
          readonly parent?: WidgetPayload;
          readonly findings: readonly WidgetFindingPayload[];
        }
        export interface WidgetFindingPayload {
          readonly ruleId: string;
        }
      `)
    );
    expect(chains).toHaveLength(1);
  });
});

describe('what each of the four columns counts', () => {
  it('reports every version on the chain, not the first one it meets', () => {
    const [chain] = chainsFrom(shapesFrom(contract));
    expect(chain?.version.map((one) => one.property)).toEqual(['rulesVersion', 'rankingVersion']);
    expect(chain?.version.every((one) => one.at === 'WidgetPayload')).toBe(true);
  });

  it('does not count the rule identity as one of the resources it was found on', () => {
    const [chain] = chainsFrom(
      shapesFrom(`
        export interface AdvisoryPayload {
          readonly widgets?: WidgetPayload;
        }
        export interface WidgetPayload {
          readonly reasons: readonly ReasonPayload[];
        }
        export interface ReasonPayload {
          readonly ruleId: string;
          readonly observed: string;
        }
      `)
    );
    expect(chain?.identity.property).toBe('ruleId');
    expect(chain?.resource).toEqual([]);
  });

  it('counts a number reached through an array of evidence as a baseline', () => {
    const [chain] = chainsFrom(shapesFrom(contract));
    expect(chain?.baseline).toEqual([{ property: 'evidence', through: 'EvidencePayload' }]);
  });

  it('calls a measurement already written into a sentence prose, not a baseline', () => {
    const [chain] = chainsFrom(
      shapesFrom(`
        export interface AdvisoryPayload {
          readonly widgets?: WidgetPayload;
        }
        export interface WidgetPayload {
          readonly reasons: readonly ReasonPayload[];
        }
        export interface ReasonPayload {
          readonly ruleId: string;
          readonly detail: string;
          readonly observed: string;
        }
      `)
    );
    expect(chain?.baseline).toEqual([]);
    // `detail` is narrative and `observed` is data, so only one of the two strings is reported.
    expect(chain?.prose).toEqual(['observed']);
  });

  it('says an identity typed as any string is not a closed set', () => {
    const [chain] = chainsFrom(shapesFrom(contract));
    expect(chain?.identity).toEqual({ property: 'rule', closed: false });
  });
});

describe('the committed recording is what a fresh run of the apparatus produces', () => {
  it('matches measure() of the contract, so a field added without re-recording fails here', () => {
    const fresh = measure();
    const recorded = JSON.parse(readFileSync(RECORDING, 'utf8')) as Census;
    expect(fresh.chains).toEqual(recorded.chains);
    expect(fresh.totals).toEqual(recorded.totals);
    expect(fresh.declared).toEqual(recorded.declared);
  });

  it('finds the five advisors the Optimisation surfaces are served from', () => {
    const advisors = [...new Set(measure().chains.map((chain) => chain.advisor))];
    expect(advisors.sort()).toEqual(['jobs', 'serverless', 'sizing', 'workload', 'writes']);
  });
});
