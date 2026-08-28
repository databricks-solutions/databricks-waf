import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';

import {
  ActionPanel,
  CustomerPage,
  Fact,
  FactList,
  PageLead,
  RecordButton,
  RecordLink,
  RecordList,
  Signal,
  StateNotice,
  Surface,
  TaskWorkspace,
  TechnicalDisclosure,
} from './index';

const html = (element: React.JSX.Element): string => renderToStaticMarkup(element);
const customerSystemCss = readFileSync(new URL('../../styles/customer-system.css', import.meta.url), 'utf8');

describe('the customer action grammar', () => {
  it('leads with the exact action before why, destination, ownership, verification and evidence', () => {
    const markup = html(
      <ActionPanel
        title="Enable serverless compute"
        why="The measured job used an all-purpose cluster."
        action={<a href="/exact-destination">Open job settings</a>}
        destination="Daily usage ingestion"
        owner="Platform engineering"
        verification="The next assessment reads it again"
        details={<span>Raw observation</span>}
      />
    );

    const ordered = [
      'Enable serverless compute',
      'Open job settings',
      'Why',
      'The measured job used an all-purpose cluster.',
      'Where',
      'Daily usage ingestion',
      'Owner',
      'Platform engineering',
      'Verify',
      'The next assessment reads it again',
      'Raw observation',
    ].map((text) => markup.indexOf(text));

    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(markup).toContain('aria-labelledby=');
  });

  it('responds to its own inspector width and wraps exact technical action names', () => {
    expect(customerSystemCss).toContain('container-name: customer-action');
    expect(customerSystemCss).toContain('@container customer-action (max-width: 760px)');
    expect(customerSystemCss).toMatch(/\.wa-action-panel-title\s*\{[^}]*overflow-wrap: anywhere/s);
  });
});

describe('role-based surfaces', () => {
  it('gives customer content one main landmark so its page lead does not create a second banner', () => {
    const markup = html(
      <CustomerPage as="main" id="content" tabIndex={-1}>
        <PageLead title="Dashboard" summary="Where the estate stands" />
      </CustomerPage>
    );

    expect(markup).toContain('<main id="content" tabindex="-1" class="wa-customer-page">');
  });

  it('uses a real page heading and keeps summary and context with it', () => {
    const markup = html(<PageLead title="Dashboard" summary="Where the estate stands" context="Measured 21 August" />);

    expect(markup).toContain('<h1 class="wa-type-page">Dashboard</h1>');
    expect(markup.indexOf('Where the estate stands')).toBeLessThan(markup.indexOf('Measured 21 August'));
  });

  it('names a titled section through its heading and a titleless section only through an explicit label', () => {
    const titled = html(
      <Surface title="Affected resources" tone="task">
        two jobs
      </Surface>
    );
    const labelled = html(
      <Surface label="Evidence" tone="inset">
        source
      </Surface>
    );

    expect(titled).toContain('aria-labelledby=');
    expect(titled).toContain('wa-customer-surface-task');
    expect(labelled).toContain('aria-label="Evidence"');
    expect(labelled).not.toContain('aria-labelledby=');
  });

  it('allows a nested surface to preserve the document heading hierarchy', () => {
    const markup = html(
      <Surface title="Parent">
        <Surface title="Affected resources" headingLevel={3}>
          two jobs
        </Surface>
      </Surface>
    );

    expect(markup).toContain('<h2');
    expect(markup).toContain('<h3');
  });
});

describe('progressive technical detail', () => {
  it('is collapsed by default and remains a native keyboard-operable disclosure', () => {
    const markup = html(<TechnicalDisclosure hint="3 observations">Raw payload</TechnicalDisclosure>);

    expect(markup).toContain('<details class="wa-technical-disclosure">');
    expect(markup).toContain('<summary>');
    expect(markup).toContain('Technical evidence');
    expect(markup).toContain('Raw payload');
  });

  it('can be deliberately open in a detail-first context', () => {
    expect(html(<TechnicalDisclosure open>Raw payload</TechnicalDisclosure>)).toContain(
      '<details class="wa-technical-disclosure" open="">'
    );
  });
});

describe('supporting signals', () => {
  it('marks a directional value structurally rather than relying on muted colour', () => {
    const markup = html(<Signal label="Directional posture" value="72–94" tone="directional" />);

    expect(markup).toContain('wa-signal-directional');
    expect(markup).toContain('Directional posture');
  });
});

describe('record and selection roles', () => {
  it('keeps selection, human identity and the opening cue in one keyboard control', () => {
    const markup = html(
      <RecordList label="Priority actions">
        <RecordButton
          selected
          onSelect={() => undefined}
          eyebrow="Reliability · High"
          title="Separate production ingestion"
          summary="Daily usage ingestion"
          meta="Owner not assigned"
          aside="Current"
        />
      </RecordList>
    );

    expect(markup).toContain('<ul class="wa-record-list" aria-label="Priority actions">');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup.indexOf('Separate production ingestion')).toBeLessThan(markup.indexOf('Daily usage ingestion'));
    expect(markup).toContain('wa-record-open');
  });

  it('uses route links for navigable records and exposes the selected URL state', () => {
    const markup = html(
      <MemoryRouter>
        <RecordList label="Findings">
          <RecordLink to="/investigate?control=REL-03-02" selected title="Use isolated compute" />
        </RecordList>
      </MemoryRouter>
    );

    expect(markup).toContain('href="/investigate?control=REL-03-02"');
    expect(markup).toContain('aria-current="true"');
  });

  it('reserves separate desktop columns for the record state and opening cue', () => {
    expect(customerSystemCss).toMatch(
      /\.wa-record-action\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto 18px;/s
    );
    expect(customerSystemCss).toContain('box-shadow: inset 0 0 0 2px var(--wa-action);');
    expect(customerSystemCss).toContain('@media (forced-colors: active)');
    expect(customerSystemCss).toContain('border: 2px solid Highlight;');
  });

  it('names the queue and current task without restoring the deprecated pane shell', () => {
    const markup = html(
      <TaskWorkspace queueLabel="Requirements" taskLabel="Selected requirement" queue="queue" task="task" />
    );

    expect(markup).toContain('aria-label="Requirements"');
    expect(markup).toContain('aria-label="Selected requirement"');
    expect(markup).toContain('wa-task-workspace');
    expect(markup).toContain('Skip to selected requirement');
    expect(markup).toMatch(/href="#task-workspace-[^"]+"/);
    expect(markup).toMatch(/id="task-workspace-[^"]+"[^>]*tabindex="-1"/);
    expect(markup).not.toContain('wa-panes');
    expect(markup).not.toContain('wa-panel');
  });
});

describe('evidence facts and task states', () => {
  it('keeps each fact label, value and qualification in one definition-list group', () => {
    const markup = html(
      <FactList label="Action facts">
        <Fact label="Owner" value="Platform engineering" detail="Accountable team" emphasis="strong" />
      </FactList>
    );

    expect(markup).toContain('<dl class="wa-fact-list" aria-label="Action facts">');
    expect(markup.indexOf('<dt>Owner</dt>')).toBeLessThan(markup.indexOf('Platform engineering'));
    expect(markup).toContain('data-emphasis="strong"');
  });

  it('does not infer alert urgency from a partial tone', () => {
    const partial = html(
      <StateNotice tone="partial" announce="status" title="One pillar did not complete" detail="Six are available." />
    );
    const failure = html(
      <StateNotice tone="danger" announce="alert" title="The assessment could not be read" detail="Try again." />
    );

    expect(partial).toContain('role="status"');
    expect(partial).not.toContain('role="alert"');
    expect(failure).toContain('role="alert"');
  });
});
