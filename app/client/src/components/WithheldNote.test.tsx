// A withheld field is shown as the sentence the server sent, wherever the field would have been.
//
// The server decides what a reader outside the assessor group may see and says so in the placeholder.
// What is held here is that the page prints that sentence in place of each restricted field and leaves
// nothing of the field behind: on a finding's evidence, on a query's text and on an import's collector.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AdvisorContext, type AdvisorValue } from '../api/advisor-context';
import { WorkloadsPage } from '../pages/WorkloadsPage';
import { EvidenceImport } from './EvidenceImport';
import { collectedBySentence } from './import-language';
import { EvidenceValue, WithheldNote } from './WithheldNote';
import { readSentence } from './provenance-language';
import type { Advisory, Evidence, EvidenceImport as Imported, Withheld, WorkloadShape } from '../api/types';

const statement: Withheld = {
  withheld: 'statement-text',
  reason: 'Statement text is withheld. Only direct members of the waf-assessors group can see it.',
  visibleTo: 'waf-assessors',
};

const principals: Withheld = {
  withheld: 'principal-identifiers',
  reason:
    'The names of the users, service principals and token creators here are withheld. Only direct members of the waf-assessors group can see it.',
  visibleTo: 'waf-assessors',
};

const reading: Withheld = {
  withheld: 'admin-reading',
  reason: 'An administrator’s imported reading is withheld. Only direct members of the waf-assessors group can see it.',
  visibleTo: 'waf-assessors',
};

describe('the placeholder', () => {
  it('prints what was withheld and who can see it, and says what kind it is', () => {
    const markup = renderToStaticMarkup(<WithheldNote withheld={statement} />);

    expect(markup).toContain('Statement text is withheld.');
    expect(markup).toContain('waf-assessors');
    expect(markup).toContain('data-withheld="statement-text"');
  });
});

describe('a query whose text is withheld', () => {
  const shape = {
    shape: 'abc0000000000000',
    workspaceId: 'w1',
    statementType: 'SELECT',
    score: 1,
    trend: { kind: 'chronic', runsNow: 10, runsBefore: 10 },
    statementWithheld: statement,
    findings: [
      {
        rule: 'EXAMPLE_RULE',
        severity: 'high',
        confidence: 'high',
        action: 'Check the query',
        headline: 'Reads far more than it returns',
        detail: 'A wide scan.',
        docUrl: 'https://docs.databricks.com/example',
        evidence: [],
      },
    ],
    representativeMeasured: true,
    runs: 10,
    measuredRuns: 10,
    totalMs: 1000,
    readBytes: 0,
    spilledBytes: 0,
    shuffleBytes: 0,
    readFiles: 0,
    queueMs: 0,
    cacheHits: 0,
    failures: 0,
    warehouses: 1,
    jobs: 0,
    pipelines: 0,
  } as WorkloadShape;

  function page(): string {
    const advisory: Advisory = {
      id: 'advisory-1',
      runId: 'run-1',
      finishedAt: '2026-08-07T09:52:00.000Z',
      state: 'complete',
      scope: 'workspace',
      lookbackDays: 14,
      actor: 'analyst@example.com',
      sighted: true,
      workload: {
        top: [shape],
        failing: [],
        coverage: {
          coveredMs: 1000,
          excludedMs: 0,
          selfMs: 0,
          coveredRuns: 10,
          excludedRuns: 0,
          selfRuns: 0,
          ambiguousMs: 0,
          ambiguousRuns: 0,
          ambiguousShapes: 0,
          percent: 100,
        },
        considered: 1,
        findingCount: 0,
        rankingVersion: 'v1',
        rulesVersion: 1,
        windowDays: 14,
      },
    };
    const value: AdvisorValue = {
      advisory,
      loading: false,
      advising: false,
      runAdvisor: () => undefined,
      reload: () => undefined,
    };
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={['/workloads?shape=abc0000000000000']}>
        <AdvisorContext.Provider value={value}>
          <WorkloadsPage />
        </AdvisorContext.Provider>
      </MemoryRouter>
    );
  }

  it('prints the placeholder on the shape\'s profile, where the text would have been, and no code block', () => {
    const markup = page();

    expect(markup).toContain('The query');
    expect(markup).toContain('data-withheld="statement-text"');
    expect(markup).toContain('waf-assessors');
    expect(markup).not.toContain('<pre');
  });
});

describe('an import whose collector is withheld', () => {
  const held: Imported = {
    digest: `sha256:${'ab'.repeat(32)}`,
    generatedAt: '2026-08-02T10:00:00Z',
    importedAt: '2026-08-03T11:00:00Z',
    importedBy: 'assessor@example.com',
    collectedByWithheld: principals,
    workspaceTier: true,
    accountTier: true,
    observed: 28,
    refused: 1,
    requirements: 55,
    scriptVersion: '1',
    cautions: [],
  };

  it('says who uploaded it and who can see who collected it, rather than that the collector is unknown', () => {
    const sentence = collectedBySentence(held);

    expect(sentence).toContain('Uploaded by assessor@example.com.');
    expect(sentence).toContain('waf-assessors');
    expect(sentence).not.toContain('not recorded');
  });

  it('prints that sentence on the import list', () => {
    const markup = renderToStaticMarkup(
      <EvidenceImport imports={{ durable: true, imports: [held], acceptedForDays: 30 }} />
    );

    expect(markup).toContain('can see it');
    expect(markup).toContain('waf-assessors');
  });
});

describe('a finding whose evidence is withheld', () => {
  const evidence = (over: Partial<Evidence>): Evidence => ({
    signal: 'rest:workspace:token.list',
    observed: 'sent as text for a consumer that has never heard of the placeholder',
    coverage: { mode: 'complete' },
    collectedAt: '2026-08-01T00:00:00Z',
    ...over,
  });

  it('prints the placeholder where the observation would have been', () => {
    const markup = renderToStaticMarkup(<EvidenceValue evidence={evidence({ withheld: principals })} />);

    expect(markup).toContain('data-withheld="principal-identifiers"');
    expect(markup).toContain('waf-assessors');
    expect(markup).not.toContain('never heard of');
  });

  it('prints the observation itself where nothing is withheld', () => {
    expect(renderToStaticMarkup(<EvidenceValue evidence={evidence({ observed: '2 of 5 tokens never expire' })} />)).toBe(
      '2 of 5 tokens never expire'
    );
  });

  it('says in the source line that an imported reading is withheld, in place of who read it', () => {
    expect(readSentence(evidence({ withheld: reading }))).toBe(reading.reason);
  });

  it('keeps saying who read an ordinary reading', () => {
    const sentence = readSentence(
      evidence({
        provenance: { surface: 'sql', collector: 'sql', authority: 'on-behalf-of-user', actor: 'runner@example.com' },
      })
    );

    expect(sentence).toContain('runner@example.com');
  });
});
