// The download panel, asserted on the HTML it emits.
//
// What is worth testing here is not the layout. It is that the three things an admin needs before
// running a vendor's script against production with account-admin authority are on the page at the
// same time as the link: the digest, the commands that reproduce it, and the sentence saying what a
// mismatch means. A checksum published somewhere else is a checksum nobody checks.
//
// The panel also has to disappear cleanly. It hangs off a disclosure on a page about something else,
// and the metadata request that feeds it can be in flight or have failed. Rendering a broken download
// box — or an error about one — would interrupt the assessment to report a problem with an aside.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminScript } from './AdminScript';
import type { EvidenceScript } from '../api/types';

const DIGEST = 'sha256:0f4a1e2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7';

function script(over: Partial<EvidenceScript> = {}): EvidenceScript {
  return {
    name: 'collect-evidence.py',
    href: '/api/evidence/collect-evidence.py',
    version: '1.0.0',
    schema: 'waf.evidence/1',
    bytes: 41_872,
    digest: DIGEST,
    modifiedAt: '2026-08-03T00:00:00.000Z',
    verify: [
      'shasum -a 256 collect-evidence.py',
      'python3 collect-evidence.py --self-digest',
      `expected: ${DIGEST}`,
    ],
    ...over,
  };
}

describe('AdminScript', () => {
  it('puts the digest and the commands that reproduce it next to the link', () => {
    const html = renderToStaticMarkup(<AdminScript script={script()} />);

    expect(html).toContain('/api/evidence/collect-evidence.py');
    expect(html).toContain('shasum -a 256 collect-evidence.py');
    // The bare hex, not just the prefixed form, because that is what a shell prints.
    expect(html).toContain('0f4a1e2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7');
  });

  it('says what a digest that does not match means, rather than leaving it implied', () => {
    const html = renderToStaticMarkup(<AdminScript script={script()} />);

    expect(html).toContain('is not the one this app published');
  });

  it('says how many requirements are waiting on it when the page knows', () => {
    const html = renderToStaticMarkup(<AdminScript script={script()} waiting={39} />);

    expect(html).toContain('39 of these requirements');
  });

  it('does not invent a count it was not given', () => {
    const html = renderToStaticMarkup(<AdminScript script={script()} />);

    expect(html).not.toMatch(/\d+ of these requirements/);
    expect(html).toContain('Some of these');
  });

  it('renders nothing at all until the app has published something to download', () => {
    expect(renderToStaticMarkup(<AdminScript />)).toBe('');
  });

  it('offers the file the app published, not a name of its own', () => {
    const html = renderToStaticMarkup(
      <AdminScript script={script({ name: 'collect-evidence-2.py', href: '/api/evidence/collect-evidence-2.py' })} />
    );

    expect(html).toContain('download="collect-evidence-2.py"');
    expect(html).toContain('Download collect-evidence-2.py');
  });
});
