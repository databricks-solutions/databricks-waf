// The serverless-only product list must stay identical across the three statements that
// classify spend. Diverging them reintroduces the measured understatement where
// product_features.is_serverless is false on MODEL_SERVING and LAKEBASE.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STATEMENTS = join(dirname(fileURLToPath(import.meta.url)), '../../../config/statements');

const FILES = ['cost_compute_mix.sql', 'estate_compute_profile.sql', 'serverless_job_spend.sql'] as const;

/** Extract the first serverless-only IN (…) list from a statement. */
function serverlessOnlyList(sql: string): string {
  const match = /billing_origin_product IN \(\s*([\s\S]*?)\s*\)/.exec(sql);
  if (match?.[1] == null) throw new Error('No billing_origin_product IN (…) list found');
  return match[1]
    .split(',')
    .map((part) => part.trim().replace(/^'|'$/g, ''))
    .filter((part) => part !== '')
    .sort()
    .join(',');
}

describe('serverless-only product vocabulary', () => {
  it('is identical in compute mix, estate profile and job spend', () => {
    const lists = FILES.map((name) => serverlessOnlyList(readFileSync(join(STATEMENTS, name), 'utf8')));
    expect(new Set(lists).size).toBe(1);
  });

  it('still names the products that measured false under the flag alone', () => {
    const list = serverlessOnlyList(readFileSync(join(STATEMENTS, 'cost_compute_mix.sql'), 'utf8'));
    expect(list.split(',')).toEqual(
      expect.arrayContaining(['MODEL_SERVING', 'LAKEBASE', 'APPS', 'SHARED_SERVERLESS_COMPUTE'])
    );
  });
});

describe('price coverage', () => {
  /**
   * The two statements whose monetary figures a resolver gates on coverage before reporting.
   * `serverless_job_spend.sql` is deliberately not here: it constrains `usage_unit = 'DBU'` in its own
   * WHERE, so it has no units to mix, and asserting a per-unit grouping on it would fail for the
   * right reason.
   */
  const GATED = ['cost_attribution_coverage.sql', 'cost_compute_mix.sql'] as const;

  it('measures the priced share per usage unit, not over units pooled together', () => {
    for (const name of GATED) {
      const sql = readFileSync(join(STATEMENTS, name), 'utf8');
      expect(sql, name).toMatch(/GROUP BY usage_unit/);
      expect(sql, name).toMatch(/least_priced_unit/);
      expect(sql, name).toMatch(/least_priced_share/);
    }
  });

  it('returns no pooled quantity pair, so the ratio that mixed units cannot be written again', () => {
    // The correction is the absence: `priced_quantity` and `unpriced_quantity` came back summed across
    // units and were divided by each other to decide whether four cost controls reported a share.
    for (const name of GATED) {
      const sql = readFileSync(join(STATEMENTS, name), 'utf8');
      // The outermost SELECT only: both statements compute a priced quantity per unit inside the CTE,
      // which is where the figure belongs. What must not come back is the pair pooled across units.
      const returned = sql.slice(sql.lastIndexOf('\nSELECT\n'));
      expect(returned, name).not.toMatch(/AS\s+priced_quantity\b/);
      expect(returned, name).not.toMatch(/AS\s+unpriced_quantity\b/);
    }
  });

  it('counts the currencies it found and the price rows that matched twice', () => {
    // Both are conditions under which every monetary total in the row is unreportable: one adds unlike
    // amounts, the other counts some usage twice. A statement carrying the coverage columns without
    // these would gate on the gap it can see and not on the two it cannot.
    for (const name of GATED) {
      const sql = readFileSync(join(STATEMENTS, name), 'utf8');
      expect(sql, name).toMatch(/AS\s+currencies/);
      expect(sql, name).toMatch(/AS\s+duplicate_price_matches/);
    }
  });
});

describe('list-price join boundary', () => {
  it('uses usage_end_time on every priced billing statement', () => {
    for (const name of ['cost_attribution_coverage.sql', 'cost_compute_mix.sql', 'serverless_job_spend.sql']) {
      const sql = readFileSync(join(STATEMENTS, name), 'utf8');
      expect(sql, name).toMatch(/usage_end_time\s*>=\s*p\.price_start_time/);
      expect(sql, name).not.toMatch(/usage_start_time\s*>=\s*p\.price_start_time/);
    }
  });
});
