// The loader, asserted on what it refuses.
//
// Every test here is about a way the shipped file could be wrong, because that is the only
// thing this module does. The rules are claims about a platform that changes underneath
// them, and the failure they exist to prevent is a confident sentence telling a customer
// they cannot do something the platform started supporting last quarter. So an
// uncited claim does not load, and a rule that has drifted from the code that fires it does
// not load either — loudly, at startup, rather than quietly at the point of display.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dump } from 'js-yaml';
import { loadRules, RULE_IDS, rulesDirectory, serverlessRules } from './serverless-rules.js';

// The fixture is typed as every field being optional and free-form, which is what a file on
// disk is. Typing it as the loaded shape instead would mean each test that breaks one field
// has to assert its way past the compiler, and the assertions then hide which field is broken.
interface RuleDraft {
  id?: unknown;
  kind?: unknown;
  action?: unknown;
  headline?: unknown;
  detail?: unknown;
  doc_url?: unknown;
}

interface AssumptionDraft {
  id?: unknown;
  statement?: unknown;
  doc_url?: unknown;
}

interface FileDraft {
  version?: unknown;
  assumptions?: AssumptionDraft[];
  rules?: RuleDraft[];
}

/** A file with every rule the analyzer fires, so a test can then break exactly one thing. */
function complete(): FileDraft & { assumptions: AssumptionDraft[]; rules: RuleDraft[] } {
  return {
    version: 1,
    assumptions: [
      { id: 'dbu-parity', statement: 'A'.repeat(60) },
      { id: 'cloud-bill-excluded', statement: 'B'.repeat(60), doc_url: 'https://docs.databricks.com/x' },
    ],
    rules: RULE_IDS.map((id) => ({
      id,
      kind: 'rework',
      action: `Do the concrete work required for ${id}`,
      headline: `Something about ${id}`,
      detail: `A detail long enough to say what specifically breaks for ${id}, at length.`,
      doc_url: 'https://docs.databricks.com/aws/en/compute/serverless/limitations',
    })),
  };
}

function withFile(content: FileDraft | string): string {
  const directory = mkdtempSync(join(tmpdir(), 'waf-rules-'));
  writeFileSync(join(directory, 'serverless-rules.yaml'), typeof content === 'string' ? content : dump(content));
  return directory;
}

describe('the shipped ruleset', () => {
  it('loads', () => {
    const ruleset = serverlessRules();
    expect(ruleset.version).toBe(1);
    expect(ruleset.rules.size).toBe(RULE_IDS.length);
  });

  it('cites a Databricks documentation page for every rule', () => {
    for (const rule of serverlessRules().rules.values()) {
      expect(rule.docUrl, rule.id).toMatch(/^https:\/\/docs\.databricks\.com\//);
    }
  });

  it('says something specific in every detail, not a restatement of the headline', () => {
    for (const rule of serverlessRules().rules.values()) {
      expect(rule.action.length, rule.id).toBeGreaterThan(20);
      expect(rule.detail.length, rule.id).toBeGreaterThan(80);
      expect(rule.detail, rule.id).not.toBe(rule.headline);
    }
  });

  it('is found where the app is deployed, not only where the source is', () => {
    expect(rulesDirectory()).toMatch(/config\/analyze$/);
  });
});

describe('what the loader refuses', () => {
  it('a missing file, naming the path rather than reporting an empty analysis', () => {
    expect(() => loadRules(join(tmpdir(), 'waf-rules-absent'))).toThrow(/bundle is incomplete/);
  });

  it('a file that is not a YAML document', () => {
    expect(() => loadRules(withFile('just a string'))).toThrow(/not a YAML document/);
  });

  it('a file with no version, since the version is what makes a shape change legible', () => {
    const { version: _dropped, ...rest } = complete();
    expect(() => loadRules(withFile(rest))).toThrow(/numeric version/);
  });

  it('a rule with no id', () => {
    const file = complete();
    file.rules[0].id = '';
    expect(() => loadRules(withFile(file))).toThrow(/rule with no id/);
  });

  it('a rule whose kind is not one of the four', () => {
    const file = complete();
    file.rules[0].kind = 'warning';
    expect(() => loadRules(withFile(file))).toThrow(/which is not one of/);
  });

  it('a rule with a detail too short to tell anybody what breaks', () => {
    const file = complete();
    file.rules[0].detail = 'It breaks.';
    expect(() => loadRules(withFile(file))).toThrow(/too short to say anything/);
  });

  it('a rule with no concrete action', () => {
    const file = complete();
    delete file.rules[0].action;
    expect(() => loadRules(withFile(file))).toThrow(/no concrete action/);
  });

  // The one that matters most: an uncited claim is a claim nobody can check against a
  // platform that changes, and this analysis is entirely claims.
  it('a rule that cites no documentation', () => {
    const file = complete();
    delete file.rules[0].doc_url;
    expect(() => loadRules(withFile(file))).toThrow(/cites no documentation/);
  });

  it('a rule citing something that is not an https URL', () => {
    const file = complete();
    file.rules[0].doc_url = 'see the docs';
    expect(() => loadRules(withFile(file))).toThrow(/cites no documentation/);
  });

  it('the same rule declared twice', () => {
    const file = complete();
    file.rules.push({ ...file.rules[0] });
    expect(() => loadRules(withFile(file))).toThrow(/twice/);
  });

  it('a rule the analyzer fires that the file does not declare', () => {
    const file = complete();
    file.rules = file.rules.slice(1);
    expect(() => loadRules(withFile(file))).toThrow(/which the file does not declare/);
  });

  it('a rule in the file that nothing fires', () => {
    const file = complete();
    file.rules.push({
      id: 'invented-limitation',
      kind: 'blocker',
      action: 'Remove the limitation before moving the job',
      headline: 'Something nobody checks',
      detail: 'A detail long enough to pass the length check but attached to no condition at all.',
      doc_url: 'https://docs.databricks.com/x',
    });
    expect(() => loadRules(withFile(file))).toThrow(/which nothing fires/);
  });

  it('a file with no cost assumptions, since the estimate is not publishable without them', () => {
    const { assumptions: _dropped, ...rest } = complete();
    expect(() => loadRules(withFile(rest))).toThrow(/no cost assumptions/);
  });

  it('an assumption too short to be one', () => {
    const file = complete();
    file.assumptions[0].statement = 'It might cost less.';
    expect(() => loadRules(withFile(file))).toThrow(/too short to be one/);
  });

  it('accepts a complete file, so the refusals above are about the fault and not the fixture', () => {
    const ruleset = loadRules(withFile(complete()));
    expect(ruleset.rules.size).toBe(RULE_IDS.length);
    expect(ruleset.assumptions).toHaveLength(2);
    expect(ruleset.assumptions[1]?.docUrl).toBe('https://docs.databricks.com/x');
    expect(ruleset.assumptions[0]?.docUrl).toBeUndefined();
  });
});
