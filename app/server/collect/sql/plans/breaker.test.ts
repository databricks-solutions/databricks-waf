import { describe, expect, it } from 'vitest';
import { DEFAULT_BREAKER_THRESHOLD, PlanBreaker } from './breaker.js';

describe('PlanBreaker', () => {
  it('stays shut until the threshold, then stays open', () => {
    const breaker = new PlanBreaker(3);
    breaker.failed();
    breaker.failed();
    expect(breaker.open()).toBe(false);
    breaker.failed();
    expect(breaker.open()).toBe(true);

    // No half-open state to fall back through: a run that gave up has given up.
    breaker.answered();
    expect(breaker.open()).toBe(true);
  });

  it('counts consecutive failures rather than total, so an endpoint answering most of the time finishes', () => {
    const breaker = new PlanBreaker(3);
    for (let i = 0; i < 10; i += 1) {
      breaker.failed();
      breaker.failed();
      breaker.answered();
    }
    expect(breaker.open()).toBe(false);
  });

  // A 404 is the expected reply for the residue `33l` does not pre-filter, so counting it as a failure
  // would open the breaker on a healthy estate whose shapes mostly ran on warehouses it cannot see.
  it('treats an answer as an answer whatever it says', () => {
    const breaker = new PlanBreaker(2);
    breaker.failed();
    breaker.answered();
    breaker.failed();
    expect(breaker.open()).toBe(false);
  });

  it('defaults to a threshold the measurement in breaker.ts chose', () => {
    expect(DEFAULT_BREAKER_THRESHOLD).toBe(5);
    const breaker = new PlanBreaker();
    for (let i = 0; i < DEFAULT_BREAKER_THRESHOLD - 1; i += 1) breaker.failed();
    expect(breaker.open()).toBe(false);
    breaker.failed();
    expect(breaker.open()).toBe(true);
  });
});
