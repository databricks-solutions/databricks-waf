// The commitments panel, asserted on the HTML it emits.
//
// Three properties here are the whole reason the panel is not a coloured dot beside a number.
//
// The standing is a word as well as a colour. "Behind" and "Gap" are two situations that want two
// different responses — one has time left, the other has a date that has passed — and a reader in
// greyscale, in bright sun, or with a colour vision deficiency gets no signal from the icon alone.
//
// The sentence is the server's. The arithmetic behind "8 points short with 61 days left" is done
// once, on the side that computed the score, because the same sum written twice drifts and two
// numbers disagreeing on one screen about whether a promise was kept is worse than either.
//
// A pillar the assessment does not cover does not link. Its page would show the reader nothing about
// the thing they clicked, and a link that lands nowhere useful is a worse answer than plain text.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { Commitment, CommitmentFor, Commitments } from './Commitments';
import type { TargetReading } from '../api/types';

function reading(over: Partial<TargetReading> = {}): TargetReading {
  return {
    pillar: 'cost',
    atLeast: 80,
    by: '2026-12-31T00:00:00.000Z',
    standing: 'met',
    due: false,
    score: 84.2,
    sentence: '84.2 against a target of 80 by 31 December 2026, which it meets with 61 days to the date.',
    ...over,
  };
}

const TITLES: Readonly<Record<string, string>> = {
  cost: 'Cost optimisation',
  reliability: 'Reliability',
};

function titleOf(pillarId: string): string {
  return TITLES[pillarId] ?? pillarId;
}

function markup(node: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe('one commitment', () => {
  it('says the standing in words, not only in colour', () => {
    expect(markup(<Commitment target={reading()} pillarTitle={titleOf} />)).toContain('Met');
    expect(markup(<Commitment target={reading({ standing: 'short' })} pillarTitle={titleOf} />)).toContain('Behind');
    expect(markup(<Commitment target={reading({ standing: 'gap' })} pillarTitle={titleOf} />)).toContain('Gap');
  });

  /*
   * "Gap" rather than "Missed". The commitment is still the commitment; what changed is that there is
   * no longer time in which to reach it, and the server's own vocabulary says so. Two words for one
   * state across two surfaces is how a reader comes to believe they are two states.
   */
  it('calls a passed date a gap, in the same word the server uses', () => {
    const said = markup(<Commitment target={reading({ standing: 'gap' })} pillarTitle={titleOf} />);
    expect(said).not.toContain('Missed');
    expect(said).not.toContain('Failed');
  });

  it('shows the sentence the server computed rather than working the numbers again', () => {
    const said = markup(<Commitment target={reading({ standing: 'short', sentence: '8 points short' })} pillarTitle={titleOf} />);
    expect(said).toContain('8 points short');
  });

  /*
   * Named only where the surface has not already named it. On a pillars-wide panel the reader could be
   * looking at a commitment about any of them; on one pillar's page they cannot.
   */
  it('says nothing about which pillar when the surface has already said it', () => {
    const said = markup(<Commitment target={reading()} />);
    expect(said).not.toContain('Cost optimisation');
    expect(said).not.toContain('/pillars/cost');
    expect(said).toContain('Met');
    expect(said).toContain('which it meets');
  });

  it('names the pillar by its title and links to it', () => {
    const said = markup(<Commitment target={reading()} pillarTitle={titleOf} />);
    expect(said).toContain('Cost optimisation');
    expect(said).toContain('/pillars/cost');
  });

  /*
   * The one standing that does not link. A pillar outside the assessment has no page worth landing
   * on, and the reader who clicked would arrive at a screen that says nothing about what they clicked.
   */
  it('does not link a pillar this assessment does not cover', () => {
    const said = markup(<Commitment target={reading({ standing: 'not-assessed' })} pillarTitle={titleOf} />);
    expect(said).toContain('Cost optimisation');
    expect(said).not.toContain('/pillars/cost');
  });

  it('distinguishes a pillar with no score from one outside the assessment', () => {
    expect(markup(<Commitment target={reading({ standing: 'not-scored' })} pillarTitle={titleOf} />)).toContain(
      'Not scored'
    );
    expect(markup(<Commitment target={reading({ standing: 'not-assessed' })} pillarTitle={titleOf} />)).toContain(
      'Not in this assessment'
    );
  });
});

describe('the list of them', () => {
  /*
   * The definition's order, not urgency. "The third one" has to keep meaning the same commitment
   * between two runs, or the list is one nobody can talk about in a meeting.
   */
  it('keeps the order it was given', () => {
    const said = markup(
      <Commitments
        targets={[reading({ pillar: 'reliability' }), reading({ pillar: 'cost' })]}
        pillarTitle={titleOf}
      />
    );
    expect(said.indexOf('Reliability')).toBeLessThan(said.indexOf('Cost optimisation'));
  });

  it('renders nothing at all when nothing was committed to', () => {
    expect(markup(<Commitments targets={[]} pillarTitle={titleOf} />)).toBe('');
  });
});

describe('the commitment on one pillar’s own page', () => {
  it('shows the one that is about this pillar', () => {
    const said = markup(
      <CommitmentFor targets={[reading({ pillar: 'reliability', sentence: 'about reliability' }), reading({ pillar: 'cost' })]} pillarId="cost" />
    );
    expect(said).toContain('What this assessment committed to');
    expect(said).toContain('which it meets');
    expect(said).not.toContain('about reliability');
  });

  /*
   * The pillar's name is the page title, the summary heading beside this, and the crumb above both. A
   * fourth copy is noise, and the link it used to carry went to the page it was clicked on — which the
   * repo's own drill-through rule exists to stop.
   */
  it('does not name the pillar again, or link to the page it is already on', () => {
    const said = markup(<CommitmentFor targets={[reading()]} pillarId="cost" />);
    expect(said).not.toContain('Cost optimisation');
    expect(said).not.toContain('/pillars/cost');
  });

  /*
   * Silent rather than saying "no target". An assessment that committed to three pillars did not
   * decline to commit to the other four, and printing an absence on each of their pages would turn
   * one decision into six statements.
   */
  it('says nothing when this pillar was not committed to', () => {
    expect(markup(<CommitmentFor targets={[reading()]} pillarId="reliability" />)).toBe('');
    expect(markup(<CommitmentFor targets={undefined} pillarId="cost" />)).toBe('');
  });
});
