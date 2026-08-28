// The readings, asserted on the HTML they emit.
//
// Two of these exist because of the same failure: a list that renders perfectly and leaves the reader
// with the wrong impression. An observed reading presented like a probe reads as "answering, now" when
// it means "answering, eleven hours ago". And a healthy dependency carrying an instruction is an
// instruction somebody eventually follows.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { HealthReadings } from './HealthReadings';
import type { HealthReading } from '../api/types';

const NOW = '2026-08-04T09:00:00.000Z';

function reading(over: Partial<HealthReading> = {}): HealthReading {
  return {
    dependency: 'database',
    standing: 'answering',
    provenance: 'probed',
    at: NOW,
    detail: 'The database answered.',
    ...over,
  };
}

function order(html: string): readonly string[] {
  return [...html.matchAll(/data-dependency="([^"]+)"/g)].map((match) => match[1] ?? '');
}

function render(readings: readonly HealthReading[], at = NOW): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <HealthReadings at={at} readings={readings} />
    </MemoryRouter>
  );
}

describe('HealthReadings', () => {
  it('puts what is broken first, whatever order the answer arrived in', () => {
    const html = render([
      reading({ dependency: 'warehouse', standing: 'answering' }),
      reading({ dependency: 'identity', standing: 'unknown' }),
      reading({ dependency: 'audit-log', standing: 'silent' }),
    ]);

    expect(order(html)).toEqual(['audit-log', 'identity', 'warehouse']);
  });

  it('puts the cause above the consequence when both are wrong', () => {
    // A silent database is what makes the trail degrade. A reader working down the list should meet
    // the binding to fix before the symptom it produced.
    const html = render([
      reading({ dependency: 'audit-log', standing: 'degraded' }),
      reading({ dependency: 'database', standing: 'degraded' }),
    ]);

    expect(order(html)).toEqual(['database', 'audit-log']);
  });

  it('dates an observed reading, so it is not read as a live one', () => {
    const html = render([reading({ dependency: 'warehouse', provenance: 'observed', at: '2026-08-03T22:00:00.000Z' })]);

    expect(html).toContain('Observed 11 hours ago');
    expect(html).not.toContain('Checked just now');
  });

  it('measures ages against the answer rather than against the clock', () => {
    // A page left open otherwise turns "just now" into a claim about a reading it never retook.
    const html = render(
      [reading({ provenance: 'observed', at: '2026-08-04T08:00:00.000Z' })],
      '2026-08-04T09:00:00.000Z'
    );

    expect(html).toContain('Observed 1 hour ago');
  });

  it('carries a word beside the shape for every standing', () => {
    const html = render([
      reading({ dependency: 'database', standing: 'silent' }),
      reading({ dependency: 'warehouse', standing: 'unbound' }),
    ]);

    expect(html).toContain('Silent');
    expect(html).toContain('Not bound');
    // The badge asserts it conveys a status, which is what the a11y gate holds it to.
    expect(html).toContain('data-status');
  });

  it('shows what to do only where there is something to do', () => {
    const html = render([
      reading({ dependency: 'database', standing: 'answering' }),
      reading({ dependency: 'warehouse', standing: 'unbound', action: 'Add a SQL warehouse resource.' }),
    ]);

    expect(html).toContain('What to do: </span>Add a SQL warehouse resource.');
    expect(html).toContain('href="/checks"');
    expect(html.match(/What to do/g)).toHaveLength(1);
  });

  it('says what each dependency is for, so a reading is legible without knowing the internals', () => {
    const html = render([reading({ dependency: 'identity' })]);

    expect(html).toContain('Establishes who a caller is');
  });
});
