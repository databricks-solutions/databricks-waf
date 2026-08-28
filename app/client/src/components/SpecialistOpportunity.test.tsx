// The shared specialist grammar, held as rendered HTML so a lens cannot quietly put provenance or
// mechanics back in front of the customer outcome.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SpecialistOpportunity } from './SpecialistOpportunity';

describe('a specialist opportunity', () => {
  it('reads as opportunity, observation, evidence and next action in that order', () => {
    const markup = renderToStaticMarkup(
      <SpecialistOpportunity
        recommendation="Add one cluster before shrinking this warehouse"
        title="Resize this warehouse"
        detail="Queue time was recorded while capacity was full."
        status={<span>High</span>}
        evidence={<p>42 of 50 statements were timed.</p>}
        qualification={<p>High confidence.</p>}
        guidanceUrl="https://docs.databricks.com/warehouses"
        resourceUrl="https://example.cloud.databricks.com/sql/warehouses/123"
        resourceLabel="Open warehouse settings"
        action={<span>Make this somebody&rsquo;s work</span>}
      />
    );

    expect(markup.indexOf('Do this')).toBeLessThan(markup.indexOf('Add one cluster'));
    expect(markup.indexOf('Add one cluster')).toBeLessThan(markup.indexOf('Why'));
    expect(markup.indexOf('Why')).toBeLessThan(markup.indexOf('Resize this warehouse'));
    expect(markup.indexOf('Queue time was recorded')).toBeLessThan(markup.indexOf('Open warehouse settings'));
    expect(markup.indexOf('Open warehouse settings')).toBeLessThan(markup.indexOf('Evidence and qualification'));
    expect(markup).toContain('<details');
    expect(markup).toContain('42 of 50 statements were timed.');
    expect(markup).toContain('Make this somebody');
  });

  it('does not invent empty provenance or action sections', () => {
    const markup = renderToStaticMarkup(
      <SpecialistOpportunity
        recommendation="Review this job's failed runs"
        title="Review the schedule"
        detail="The job failed twice in this window."
      />
    );

    expect(markup).not.toContain('Evidence and qualification');
    expect(markup).not.toContain('Open in Databricks');
  });
});
