import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Term, plainTerm, preciseTerm, terms, type TermId } from './plain-language';

const html = (element: React.JSX.Element): string => renderToStaticMarkup(element);

describe('the plain-language vocabulary', () => {
  const required: readonly (readonly [TermId, string])[] = [
    ['pillar', 'focus area'],
    ['attestation', 'your confirmation'],
    ['evidence', 'what we checked'],
    ['coverage', 'how much we measured'],
    ['unmeasurable', 'couldn’t check automatically'],
    ['provenance', 'where the data came from'],
    ['differential', 'what changed'],
  ];

  it('gives every domain term a plain phrase and keeps the precise one', () => {
    for (const id of Object.keys(terms) as TermId[]) {
      expect(terms[id].plain.length, id).toBeGreaterThan(0);
      expect(terms[id].precise.length, id).toBeGreaterThan(0);
    }
  });

  it('maps the terms the design names', () => {
    for (const [id, plain] of required) {
      expect(plainTerm(id), id).toBe(plain);
    }
  });

  it('maps finding, requirement and control to the everyday idea of a check', () => {
    expect(plainTerm('requirement')).toContain('check');
    expect(plainTerm('control')).toContain('check');
    expect(plainTerm('finding')).toContain('check');
  });

  it('keeps the precise term for a reader who wants it', () => {
    expect(preciseTerm('pillar')).toBe('Pillar');
    expect(preciseTerm('attestation')).toBe('Attestation');
  });
});

describe('the Term glossary helper', () => {
  it('shows the plain phrase and keeps the precise term on its title', () => {
    const markup = html(<Term id="pillar" />);
    expect(markup).toContain('focus area');
    expect(markup).toContain('title="Pillar');
    expect(markup).toContain('data-term="pillar"');
    expect(markup).toContain('wa-term');
  });

  it('can show the precise term instead, on request', () => {
    expect(html(<Term id="pillar" precise />)).toContain('>Pillar<');
  });
});
