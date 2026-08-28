import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/assessment-context', () => ({
  useAssessment: () => ({
    scanning: false,
    runScan: vi.fn(),
    choices: [
      {
        id: 'definition-1',
        name: 'Platform architecture review with a deliberately long customer-authored name',
        scope: '1 chosen workspace, over the last 30 days, covering every pillar.',
        measurement: { scope: { kind: 'selected', workspaceIds: ['w1'] }, lookbackDays: 30 },
      },
    ],
    selected: {
      id: 'definition-1',
      name: 'Platform architecture review with a deliberately long customer-authored name',
      scope: '1 chosen workspace, over the last 30 days, covering every pillar.',
      measurement: { scope: { kind: 'selected', workspaceIds: ['w1'] }, lookbackDays: 30 },
    },
    setChosen: vi.fn(),
  }),
}));

import { RunScanControl } from './RunScanControl';

describe('the assessment run control', () => {
  it('keeps the visible action short while its accessible name identifies the selected assessment', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <RunScanControl />
      </MemoryRouter>
    );

    expect(markup).toContain('Run assessment');
    expect(markup).toContain(
      'aria-label="Set scope and run: Platform architecture review with a deliberately long customer-authored name"'
    );
    expect(markup).not.toContain('wa-button-split-label');
  });
});
