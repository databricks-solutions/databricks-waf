import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ServingDeclaration } from '../api/types';
import { FoundationDeclarationForm } from './FoundationDeclarationForm';

const DECLARATION: ServingDeclaration = {
  version: 2,
  declaredAt: '2026-08-20T00:00:00.000Z',
  declaredBy: 'owner@example.com',
  fingerprint: 'sha256:abc',
  named: [{ catalog: 'main', schema: 'products', table: 'orders' }],
  tagged: [{ key: 'serving', values: ['published'], at: ['table'] }],
  requiredTagKeys: ['domain'],
  requiredMetadata: ['description', 'owner'],
  policy: [{ classification: 'restricted', requires: ['column-mask'] }],
};

function render(declaration: ServingDeclaration | null = DECLARATION): string {
  return renderToStaticMarkup(
    <FoundationDeclarationForm
      declaration={declaration}
      saving={false}
      onSubmit={() => undefined}
      onCancel={() => undefined}
    />
  );
}

describe('the serving declaration editor', () => {
  it('asks for three identifiers and explicit tag levels rather than a qualified-name pattern', () => {
    const markup = render(null);

    for (const label of ['catalog', 'schema', 'table', 'Add tag selector']) expect(markup).toContain(label);
    expect(markup).toContain('Names are never treated as patterns');
    expect(markup).not.toContain('gold schema');
  });

  it('loads the declaration being revised and says the previous version remains', () => {
    const markup = render();

    expect(markup).toContain('value="main"');
    expect(markup).toContain('value="products"');
    expect(markup).toContain('value="orders"');
    expect(markup).toContain('version 3');
    expect(markup).toContain('version 2 remains in history');
  });

  it('states that it records obligations and does not perform access or policy changes', () => {
    const markup = render();

    expect(markup).toContain('never grants access');
    expect(markup).toContain('creates row filters, masks, or ABAC policies');
  });
});
