// The import surface, asserted on the HTML it emits.
//
// What matters here is what the reader is told before they act and what they are told about what the
// app already holds — not the upload mechanics, which are the hook's and are exercised against a real
// socket in `server/api/import-routes.test.ts`.
//
// Two of these tests exist because of the same failure mode: a surface that offers to import evidence
// on an install that cannot keep it, and a surface that lists a collection without saying it is nearly
// expired. Both render perfectly and both leave somebody trusting a number they should not.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvidenceImport } from './EvidenceImport';
import type { EvidenceImport as Imported, EvidenceImports } from '../api/types';

function held(over: Partial<Imported> = {}): Imported {
  return {
    digest: `sha256:${'ab'.repeat(32)}`,
    generatedAt: '2026-08-02T10:00:00Z',
    importedAt: '2026-08-03T11:00:00Z',
    importedBy: 'assessor@example.com',
    collectedBy: 'admin@example.com',
    workspaceTier: true,
    accountTier: true,
    observed: 28,
    refused: 1,
    requirements: 55,
    scriptVersion: '1',
    cautions: [],
    ...over,
  };
}

function imports(over: Partial<EvidenceImports> = {}): EvidenceImports {
  return { durable: true, imports: [], acceptedForDays: 30, ...over };
}

describe('EvidenceImport', () => {
  it('says what the app checks before it believes a file', () => {
    const html = renderToStaticMarkup(<EvidenceImport imports={imports()} />);

    expect(html).toContain('unchanged since');
    expect(html).toContain('describe this estate');
    expect(html).toContain('not been imported before');
  });

  it('offers the upload', () => {
    const html = renderToStaticMarkup(<EvidenceImport imports={imports()} />);

    expect(html).toContain('Upload a collected file');
    expect(html).toContain('type="file"');
  });

  it('warns when an import would not survive a restart, and says what would be lost', () => {
    const html = renderToStaticMarkup(<EvidenceImport imports={imports({ durable: false })} />);

    expect(html).toContain('lost when the app restarts');
    expect(html).toContain('revert to unanswered');
  });

  it('says nothing about durability when records are kept, because that is the working case', () => {
    const html = renderToStaticMarkup(<EvidenceImport imports={imports()} />);

    expect(html).not.toContain('lost when the app restarts');
  });

  it('lists what is held with its age, its digest and both identities', () => {
    const html = renderToStaticMarkup(<EvidenceImport imports={imports({ imports: [held()] })} />);

    expect(html).toContain('1 collection imported');
    expect(html).toContain('abababababab');
    expect(html).toContain('28 readings across 55 requirements');
    expect(html).toContain('1 call was refused');
    expect(html).toContain('Collected by admin@example.com, uploaded by assessor@example.com');
  });

  it('carries a held collection\u2019s cautions rather than only showing them once at upload', () => {
    // The case this is for: an import accepted three weeks ago with the account tier missing. The
    // caution was shown then, to whoever uploaded it, and the reader looking at the score today is
    // somebody else — so it travels with the record.
    const html = renderToStaticMarkup(
      <EvidenceImport
        imports={imports({
          imports: [held({ cautions: [{ reason: 'tier-not-run', message: 'The account tier was not run.' }] })],
        })}
      />
    );

    expect(html).toContain('The account tier was not run.');
  });

  it('lists both cautions when two share a reason, which is the case when neither tier named a user', () => {
    // Static markup cannot show the failure this guards — every child renders whatever its key, and the
    // damage happens when React reconciles a re-render. `noteKey` is where that rule is asserted. What
    // this holds is the contract above it: two notes in, two sentences out, neither summarised away.
    const html = renderToStaticMarkup(
      <EvidenceImport
        imports={imports({
          imports: [
            held({
              cautions: [
                { reason: 'unattributed', message: 'The workspace tier named no collecting user.' },
                { reason: 'unattributed', message: 'The account tier named no collecting user.' },
              ],
            }),
          ],
        })}
      />
    );

    expect(html).toContain('The workspace tier named no collecting user.');
    expect(html).toContain('The account tier named no collecting user.');
  });

  it('says an account-only collection is unattributed rather than showing a blank', () => {
    const html = renderToStaticMarkup(
      <EvidenceImport imports={imports({ imports: [held({ collectedBy: undefined, workspaceTier: false })] })} />
    );

    expect(html).toContain('not recorded');
    expect(html).toContain('The account tier ran; the workspace tier did not.');
  });

  it('renders nothing at all until the app has said what it holds', () => {
    expect(renderToStaticMarkup(<EvidenceImport />)).toBe('');
  });
});
