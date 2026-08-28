// The serverless ruleset, loaded from data.
//
// Every sentence the analyzer shows a reader about what serverless can and cannot do
// lives in `config/analyze/serverless-rules.yaml`, with a documentation link per rule.
// This module loads it, checks it, and refuses to run on a file that is missing either.
//
// The check is not ceremony. The rules are claims about a platform that changes — GPU on
// serverless went from impossible to a public preview during this project — and the
// failure mode of a stale claim is a confident sentence telling a customer they cannot do
// something they can. A rule with no citation is a claim nobody can check, so it does not
// load; an id in the file that the analyzer does not know, or the reverse, is a rule that
// has drifted from the code that fires it, so that does not load either.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { shippedConfigDirectory } from '../shipped-config.js';

/**
 * What a rule says about a job.
 *
 * `blocker` and `rework` are the two that describe work. `unknown` is the honest third:
 * the configuration could not be read, so no verdict about it is available. `note` is true
 * and worth saying and changes nothing about whether the job can move.
 */
export type RuleKind = 'blocker' | 'rework' | 'unknown' | 'note';

export interface ServerlessRule {
  readonly id: string;
  readonly kind: RuleKind;
  readonly action: string;
  readonly headline: string;
  readonly detail: string;
  readonly docUrl: string;
}

export interface CostAssumption {
  readonly id: string;
  readonly statement: string;
  readonly docUrl?: string;
}

export interface ServerlessRuleset {
  readonly version: number;
  readonly rules: ReadonlyMap<string, ServerlessRule>;
  readonly assumptions: readonly CostAssumption[];
}

/**
 * The rule ids the analyzer fires, as a type.
 *
 * Declared here rather than inferred from the file so that a rule the code depends on
 * cannot be deleted from the YAML without the load failing. The two sets are compared at
 * load, which is what stops the file and the analyzer drifting apart silently.
 */
export const RULE_IDS = [
  'gpu-cluster',
  'run-exceeds-seven-days',
  'init-script',
  'instance-pool',
  'cloud-identity',
  'legacy-access-mode',
  'ml-runtime',
  'runtime-predates-serverless',
  'continuous-trigger',
  'compute-unclassified',
  'cluster-unreadable',
  'configuration-unwritten',
  'all-purpose-cluster',
  'policy-governed',
  'outside-metadata',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

const KINDS: readonly RuleKind[] = ['blocker', 'rework', 'unknown', 'note'];

export function rulesDirectory(moduleUrl = import.meta.url): string {
  return shippedConfigDirectory('analyze', moduleUrl);
}

let cached: ServerlessRuleset | undefined;

/**
 * The ruleset, read once per process.
 *
 * Cached because it is static data read from the bundle, and re-reading it per scan would
 * put a synchronous file read on the path of every run for no benefit.
 */
export function serverlessRules(directory: string = rulesDirectory()): ServerlessRuleset {
  cached ??= loadRules(directory);
  return cached;
}

export function loadRules(directory: string): ServerlessRuleset {
  const path = join(directory, 'serverless-rules.yaml');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    // A packaging fault, like a missing statement file, and reported the same way: loudly,
    // naming the path, rather than as an analysis that found nothing.
    throw new Error(`The serverless ruleset is missing from ${path}; the app bundle is incomplete.`, { cause });
  }

  const parsed = load(text) as { version?: unknown; rules?: unknown; assumptions?: unknown } | null;
  if (parsed == null || typeof parsed !== 'object') throw new Error(`${path} is not a YAML document.`);
  if (typeof parsed.version !== 'number') throw new Error(`${path} does not declare a numeric version.`);
  if (!Array.isArray(parsed.rules)) throw new Error(`${path} declares no rules.`);

  const rules = new Map<string, ServerlessRule>();
  for (const entry of parsed.rules as readonly Record<string, unknown>[]) {
    const rule = validate(entry, path);
    if (rules.has(rule.id)) throw new Error(`${path} declares the rule ${rule.id} twice.`);
    rules.set(rule.id, rule);
  }

  const declared = [...rules.keys()].sort();
  const expected = [...RULE_IDS].sort();
  if (declared.join(',') !== expected.join(',')) {
    const missing = expected.filter((id) => !rules.has(id));
    const extra = declared.filter((id) => !expected.includes(id as RuleId));
    throw new Error(
      `${path} and the analyzer disagree about which rules exist. ` +
        (missing.length > 0 ? `The analyzer fires ${missing.join(', ')}, which the file does not declare. ` : '') +
        (extra.length > 0 ? `The file declares ${extra.join(', ')}, which nothing fires. ` : '') +
        'A rule that exists in one place and not the other is either a sentence no reader will see or a ' +
        'verdict with no words to explain it.'
    );
  }

  return { version: parsed.version, rules, assumptions: assumptionsOf(parsed.assumptions, path) };
}

function validate(entry: Record<string, unknown>, path: string): ServerlessRule {
  const id = entry['id'];
  if (typeof id !== 'string' || id === '') throw new Error(`${path} has a rule with no id.`);

  const kind = entry['kind'];
  if (typeof kind !== 'string' || !KINDS.includes(kind as RuleKind)) {
    throw new Error(`Rule ${id} in ${path} has kind ${String(kind)}, which is not one of ${KINDS.join(', ')}.`);
  }

  const headline = entry['headline'];
  const action = entry['action'];
  const detail = entry['detail'];
  const docUrl = entry['doc_url'];
  if (typeof headline !== 'string' || headline === '') throw new Error(`Rule ${id} in ${path} has no headline.`);
  if (typeof action !== 'string' || action.length < 20) {
    throw new Error(
      `Rule ${id} in ${path} has no concrete action. A recommendation must tell the reader what to do first, ` +
        'not only describe the condition.'
    );
  }
  if (typeof detail !== 'string' || detail.length < 40) {
    throw new Error(
      `Rule ${id} in ${path} has no detail, or a detail too short to say anything. ` +
        'A reader deciding whether to migrate a job needs to know what specifically breaks.'
    );
  }
  if (typeof docUrl !== 'string' || !docUrl.startsWith('https://')) {
    throw new Error(
      `Rule ${id} in ${path} cites no documentation. Every claim about what serverless cannot do has to ` +
        'link to the page that says so, because the page changes and the claim has to be checkable.'
    );
  }

  return { id, kind: kind as RuleKind, action, headline, detail, docUrl };
}

function assumptionsOf(raw: unknown, path: string): readonly CostAssumption[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `${path} declares no cost assumptions. The estimate is arithmetic on two observed numbers and one ` +
        'assumption; publishing the number without the assumption is the part that would be dishonest.'
    );
  }

  return (raw as readonly Record<string, unknown>[]).map((entry) => {
    const id = entry['id'];
    const statement = entry['statement'];
    if (typeof id !== 'string' || id === '') throw new Error(`${path} has a cost assumption with no id.`);
    if (typeof statement !== 'string' || statement.length < 40) {
      throw new Error(`Cost assumption ${id} in ${path} has no statement, or one too short to be one.`);
    }
    const docUrl = entry['doc_url'];
    return { id, statement, ...(typeof docUrl === 'string' ? { docUrl } : {}) };
  });
}
