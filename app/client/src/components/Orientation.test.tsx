// The welcome, as the reader meets it.
//
// Three properties, and each is the difference between orientation and decoration.
//
// The boundary is on the page before any action is. A welcome that put "Define an assessment" above
// "it does not certify anything" would be a consent flow with the terms underneath the button, and
// this is the only page in the app that states the boundary at all.
//
// The glossary is a definition list. Ten terms and ten meanings is exactly what `dl` describes, and it
// is the only markup a screen reader will let somebody move through term by term — a stack of divs
// with a bold word in each reads as ten paragraphs.
//
// And the onward actions are the caller's. The same words are rendered on arrival and from the rail
// afterwards, and only the first has anywhere to go next; a component that drew its own "get started"
// would put one on the page of somebody who came back to look up what coverage means.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { Orientation } from './Orientation';
import { FRAMEWORK_URL, LIMITS, ONWARD, PROMISE, WORDS } from './orientation-language';

function html(onward?: React.ReactNode): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Orientation {...(onward != null ? { onward } : {})} />
    </MemoryRouter>
  );
}

describe('Orientation', () => {
  it('says what the app is and what it will not do', () => {
    const markup = html();

    expect(markup).toContain(PROMISE.heading);
    expect(markup).toContain(LIMITS.heading);
    for (const limit of LIMITS.points) {
      expect(markup).toContain(limit.claim);
    }
  });

  it('leads with the next action while keeping the product boundary on the page', () => {
    const markup = html(<a href="/definitions/setup">Define an assessment</a>);

    expect(markup.indexOf('Define an assessment')).toBeLessThan(markup.indexOf(LIMITS.heading));
    expect(markup).toContain('It does not certify anything.');
  });

  it('renders the glossary as a definition list, one pair per term', () => {
    const markup = html();

    expect(markup).toContain('<dl');
    expect((markup.match(/<dt/g) ?? []).length).toBe(WORDS.length);
    expect((markup.match(/<dd/g) ?? []).length).toBe(WORDS.length);
  });

  it('links a term to the page it is met on', () => {
    const markup = html();
    const pillar = WORDS.find((word) => word.term === 'Pillar');

    expect(pillar?.at).toBe('/investigate');
    expect(markup).toContain('href="/investigate"');
  });

  it('sends the reader to the published framework, in a new tab and without a referrer', () => {
    const markup = html();

    expect(markup).toContain(`href="${FRAMEWORK_URL}"`);
    expect(markup).toContain('rel="noreferrer"');
  });

  it('offers nothing to do when nobody passed anything', () => {
    // The re-read case. `ONWARD` is the panel's heading, so its absence is the absence of the panel.
    expect(html()).not.toContain(ONWARD.heading);
    expect(html(<span>Onward</span>)).toContain(ONWARD.heading);
  });
});
