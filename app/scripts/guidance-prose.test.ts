import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { guidanceDirectory } from '../server/guidance/guidance.js';
import {
  COMPARED,
  REGULATIONS,
  SIMILAR,
  closestPair,
  jaccard,
  nearDuplicates,
  prose,
  significant,
  uncitedRegulations,
} from './guidance-prose.mjs';

/**
 * The three content rules L1b added to `check:guidance`, and the corpus the thresholds came from.
 *
 * The apparatus matters as much as the rule here. A similarity bar set by taste would fire on
 * honest writing or on nothing at all, and either way nobody would find out which until an author
 * argued with it — so it was set against the corpus, and this is where that measurement is kept
 * honest as the corpus grows.
 */

const CORPUS: readonly (readonly [string, Record<string, unknown>])[] = readdirSync(guidanceDirectory())
  .filter((name) => name.endsWith('.yaml'))
  .flatMap((name) => {
    const doc = yaml.load(readFileSync(join(guidanceDirectory(), name), 'utf8')) as {
      entries?: Record<string, Record<string, unknown> | null>;
    };
    return Object.entries(doc.entries ?? {})
      .filter(([, entry]) => entry?.status === 'authored')
      .map(([id, entry]) => [id, entry ?? {}] as const);
  });

describe('which words are compared', () => {
  it('drops the words every English sentence has', () => {
    const words = significant('The estate has a policy that the team should have been applying to it');

    expect([...words].sort()).toEqual(['applying', 'been', 'estate', 'have', 'policy', 'should', 'team', 'that']);
  });

  it('counts a repeated word once, so saying it twice is not saying more', () => {
    expect(significant('policy policy policy estate').size).toBe(2);
  });

  it('scores two texts with nothing long in common at zero', () => {
    expect(jaccard(significant('warehouses auto-stop after ten minutes'), significant('lineage records a read event'))).toBe(0);
  });

  it('scores a text against itself at one', () => {
    const text = 'Cluster policies make an all-purpose cluster the harder path for someone whose work is SQL';

    expect(jaccard(significant(text), significant(text))).toBe(1);
  });
});

describe('the similarity bar', () => {
  /*
   * The measurement the threshold rests on, re-taken every run.
   *
   * If the corpus grows towards the bar this fails while there is still room to move it deliberately,
   * rather than on the day an honest entry trips the gate and somebody raises the number to get their
   * pull request through. 0.32 was the closest pair when the bar was set; 0.4 is the point at which
   * the headroom is worth a conversation.
   */
  it('still has headroom over the closest pair anybody has actually written', () => {
    const closest = closestPair(CORPUS);

    expect(closest).toBeDefined();
    expect(closest!.overlap, `${closest!.one} and ${closest!.other} on ${closest!.field}`).toBeLessThan(0.4);
    expect(SIMILAR).toBeGreaterThan(closest!.overlap);
  });

  it('finds nothing to complain about in the corpus as it stands', () => {
    expect(nearDuplicates(CORPUS)).toEqual([]);
  });

  it('catches an entry pasted over another and reworded a little', () => {
    const original =
      'An analyst who wants to run a query reaches a SQL warehouse without asking anybody, and starting an ' +
      'all-purpose cluster to do the same work is either harder or not permitted.';
    const pasted =
      'An engineer who wants to run a query reaches a SQL warehouse without asking anybody, and starting an ' +
      'all-purpose cluster to do that same work is either harder or not permitted.';

    const found = nearDuplicates([
      ['CO-01-03', { means: original }],
      ['CO-01-04', { means: pasted }],
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.overlap).toBeGreaterThan(SIMILAR);
  });

  it('compares a field only against the same field, so a means and a matters never pair', () => {
    const text = 'A sentence long enough to have several significant words in it about warehouses and policies.';

    expect(nearDuplicates([['CO-01-03', { means: text }], ['CO-01-04', { matters: text }]])).toEqual([]);
  });

  it('leaves the short signal lists out, because several requirements honestly share one', () => {
    // `good` and `pitfalls` are lists of six-word signals. Included, this gate would teach authors to
    // reword a true sentence until a script stopped complaining.
    expect(COMPARED).not.toContain('good');
    expect(COMPARED).not.toContain('pitfalls');
  });

  it('reads the recommendation as well as the description, so templated advice is caught too', () => {
    expect(COMPARED).toContain('start_from');

    const text = 'One serverless warehouse per team that runs it, auto-stopping after ten minutes without a request.';
    const found = nearDuplicates([
      ['CO-01-03', { advice: { start_from: text } }],
      ['CO-01-08', { advice: { start_from: text } }],
    ]);

    expect(found[0]?.field).toBe('start_from');
  });
});

describe('what counts as a claim about the law', () => {
  it('reads every sentence a reader sees, advice included', () => {
    const sentences = prose({
      means: 'What it is.',
      verify: [{ where: 'Somewhere', caveat: 'What this cannot tell you' }],
      advice: { start_from: 'Where to start', costs: ['What it costs'], depends_on: [], path: [] },
    });

    expect(sentences).toContain('What this cannot tell you');
    expect(sentences).toContain('Where to start');
    expect(sentences).toContain('What it costs');
  });

  it('names the regulations somebody would assert', () => {
    for (const named of ['GDPR', 'HIPAA', 'PCI DSS', 'PCI-DSS', 'SOC 2', 'ISO 27001', 'DORA', 'Sarbanes-Oxley']) {
      expect(REGULATIONS.test(`This is required under ${named} for regulated data.`), named).toBe(true);
    }
  });

  it('does not fire on the abstract noun, which describes why somebody is asking', () => {
    expect(REGULATIONS.test('A regulated workload usually has the objective set for it by compliance.')).toBe(false);
  });

  /*
   * The rule this replaced could not fire, and the reason is worth a test rather than a comment.
   *
   * Written as "names one and cites nothing", it was subsumed by the citation rule twenty lines above
   * it in the same check: every entry it could have flagged was already failing. It read as a
   * guardrail over the security pillar's content phase for as long as nobody tried it. So the case
   * below is the one that matters — a claim about the law beside a citation about something else.
   */
  it('fires on a regulatory claim sourced to a page about something else', () => {
    const found = uncitedRegulations({
      matters: 'Personal data held here is subject to GDPR, which requires it be deleted on request.',
      references: ['https://docs.databricks.com/en/compute/cluster-policies.html'],
    });

    expect(found.map((one) => one.named)).toEqual(['GDPR']);
  });

  it('is satisfied by a citation that names the regulation', () => {
    expect(
      uncitedRegulations({
        matters: 'Personal data held here is subject to GDPR, which requires it be deleted on request.',
        references: ['https://docs.databricks.com/en/security/privacy/gdpr-delta.html'],
      })
    ).toEqual([]);
  });

  it('accepts the name a source is likelier to be filed under', () => {
    // Two alias groups only, and both are the same regulation under another name.
    expect(uncitedRegulations({ means: 'Cardholder data under PCI-DSS.', references: ['https://x.test/pci/'] })).toEqual([]);
    expect(uncitedRegulations({ means: 'Reporting under Sarbanes-Oxley.', references: ['https://x.test/sox/'] })).toEqual([]);
  });

  it('reports each regulation named, not only the first', () => {
    const found = uncitedRegulations({
      means: 'Applies under HIPAA and under GDPR.',
      references: ['https://x.test/hipaa/'],
    });

    expect(found.map((one) => one.named)).toEqual(['GDPR']);
  });

  it('finds no uncited regulatory claim in the corpus', () => {
    const claimed = CORPUS.filter(([, entry]) => uncitedRegulations(entry).length > 0);

    expect(claimed.map(([id]) => id)).toEqual([]);
  });

  it('and names a regulation only on the two cited SCP-04 entries 100k authored', () => {
    const naming = CORPUS.filter(([, entry]) => REGULATIONS.test(prose(entry).join(' ')));

    expect(naming.map(([id]) => id)).toEqual(['SCP-04-05', 'SCP-04-21']);
  });
});

describe('what the corpus already satisfies', () => {
  it('cites something on every authored entry', () => {
    const uncited = CORPUS.filter(([, entry]) => ((entry.references as string[] | undefined) ?? []).length === 0);

    expect(uncited.map(([id]) => id)).toEqual([]);
  });
});
