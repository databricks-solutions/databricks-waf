// The application shell exposes customer tasks rather than the route directory it replaced.
//
// These are behavior tests rather than a component snapshot: the route-to-task mapping is what
// keeps the correct task selected while legacy deep links remain addressable during the staged
// 107/110 implementation.

import { describe, expect, it } from 'vitest';
import { canonicalCustomerPath, PRIMARY_TASKS, UTILITIES, itemFor, taskFor } from './nav';

describe('the four-task application shell', () => {
  it('keeps exactly the approved customer tasks in their approved order', () => {
    expect(PRIMARY_TASKS.map((task) => task.label)).toEqual(['Assess', 'Investigate', 'Improve', 'Operate']);
  });

  it('assigns existing deep links to the customer task that owns them', () => {
    expect(taskFor('/definitions/setup')?.label).toBe('Assess');
    expect(taskFor('/review/review-1')?.label).toBe('Assess');
    expect(taskFor('/findings')?.label).toBe('Investigate');
    expect(taskFor('/investigate')?.label).toBe('Investigate');
    expect(taskFor('/serverless')?.label).toBe('Improve');
    expect(taskFor('/operate')?.label).toBe('Operate');
    expect(taskFor('/months/2026-08')?.label).toBe('Operate');
  });

  it('opens Operate on the assessment-scoped inbox rather than on one monthly record', () => {
    const operate = PRIMARY_TASKS.find((task) => task.label === 'Operate');
    expect(operate?.to).toBe('/operate');
    expect(operate?.items.map((item) => item.to)).toEqual(['/operate', '/review', '/history', '/months']);
  });

  it('opens Investigate on one composed workbench while legacy record links remain owned by it', () => {
    const investigate = PRIMARY_TASKS.find((task) => task.label === 'Investigate');
    expect(investigate?.to).toBe('/investigate');
    expect(investigate?.items.map((item) => item.to)).toEqual(['/investigate']);
    expect(itemFor('/investigate')?.label).toBe('Investigation workbench');
  });

  it('names the setup route as customer preparation rather than the implementation record', () => {
    expect(itemFor('/definitions/setup')?.label).toBe('Prepare assessment');
  });

  it('keeps the Dashboard as global orientation rather than a fifth task or an Investigate view', () => {
    expect(taskFor('/overview')).toBeUndefined();
    expect(PRIMARY_TASKS.flatMap((task) => task.items).map((item) => item.to)).not.toContain('/overview');
  });

  it('keeps method and administration pages outside customer-task selection', () => {
    expect(UTILITIES.map((item) => item.to)).toContain('/methodology');
    expect(UTILITIES.map((item) => item.to)).toContain('/diagnostics');
    expect(taskFor('/methodology')).toBeUndefined();
    expect(taskFor('/retention')).toBeUndefined();
  });

  it('gives every deterministic preview the shell identity of the production composition it renders', () => {
    expect(canonicalCustomerPath('/preview/dashboard/complete')).toBe('/overview');
    expect(itemFor('/preview/dashboard/complete')?.label).toBe('Dashboard');
    expect(taskFor('/preview/assess/review')?.label).toBe('Assess');
    expect(itemFor('/preview/investigate/empty')?.label).toBe('Investigation workbench');
    expect(taskFor('/preview/improvement/changed')?.label).toBe('Improve');
    expect(itemFor('/preview/operate/recovery')?.label).toBe('Next actions');
    expect(itemFor('/preview/report/sparse')?.label).toBe('Report');
  });
});
