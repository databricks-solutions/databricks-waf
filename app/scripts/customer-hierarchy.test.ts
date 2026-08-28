import { describe, expect, it } from 'vitest';
import { customerHierarchyProblems } from './customer-hierarchy.mjs';

const sound = {
  headings: ['Warehouses', 'Keep this warehouse stopped when it is idle'],
  emptyCount: 0,
  primaryActionLabels: ['Open in Databricks'],
  recommendations: [
    {
      text: 'Do this\nKeep this warehouse stopped when it is idle\nWhy\nIt ran no queries in the window.',
      destinationCount: 1,
      beforeSupport: true,
      inFirstViewport: true,
    },
  ],
};

describe('customer route hierarchy', () => {
  it('accepts one visible action before its supporting evidence', () => {
    expect(customerHierarchyProblems(sound)).toEqual([]);
  });

  it('rejects the hierarchy regressions geometry alone cannot see', () => {
    expect(
      customerHierarchyProblems({
        headings: ['Run 3896dbcf-69c9-4233-bc0a-482ba2fc7218'],
        emptyCount: 2,
        primaryActionLabels: ['Run the advisor', 'Run the advisor'],
        recommendations: [
          {
            text: 'Recommendation',
            destinationCount: 0,
            beforeSupport: false,
            inFirstViewport: false,
          },
        ],
      })
    ).toEqual([
      'renders 2 empty states instead of one actionable composition',
      'uses a UUID as a customer heading',
      'repeats the primary action “Run the advisor”',
      'recommendation 1 does not lead with “Do this”',
      'recommendation 1 does not explain “Why”',
      'recommendation 1 has no exact destination or in-app handoff',
      'recommendation 1 follows its supporting metrics or evidence',
      'the first recommendation begins below the viewport',
    ]);
  });
});
