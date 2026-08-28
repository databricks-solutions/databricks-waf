// The checksum panel, asserted on the HTML it emits.
//
// Three things are worth testing and none is the layout. The first is that the digest and the command
// that reproduces it are on the page together — a checksum published somewhere the sender cannot read
// out is a checksum nobody checks, which is the same failure `AdminScript.test.tsx` guards in the
// opposite direction. The second is the sentence saying what a digest does not establish: it is not a
// signature, and a reader who believes it is has been told something false by omission. The third is
// what the panel says about a copy that no longer matches, because the honest reading of that is "you
// exported this before somebody decided something" and the tempting one is "you have been tampered
// with".

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunFiles } from './RunFiles';
import type { ExportFile, RunExports } from '../api/types';

const DIGEST = 'sha256:0f4a1e2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7';

function file(over: Partial<ExportFile> = {}): ExportFile {
  return {
    name: 'well-architected-2026-03-04-run-1234.csv',
    format: 'csv',
    variant: 'technical',
    digest: DIGEST,
    bytes: 41_872,
    href: '/api/scans/run-1234567890/export.csv',
    verify: ['shasum -a 256 well-architected-2026-03-04-run-1234.csv', `# expect ${DIGEST.slice(7)}`],
    ...over,
  };
}

function published(over: Partial<RunExports> = {}): RunExports {
  return {
    scanId: 'run-1234567890',
    files: [file()],
    variants: [
      {
        variant: 'technical',
        says: 'The complete file: every requirement, everything read to judge it, and what has been decided about it.',
        files: [file()],
      },
      {
        variant: 'executive',
        says: 'For a reader who is deciding what to do about the estate rather than working on it.',
        omits: 'It carries every requirement and not every column: what was read is in the technical export.',
        files: [
          file({
            name: 'well-architected-2026-03-04-run-1234-executive.csv',
            variant: 'executive',
            href: '/api/scans/run-1234567890/export.csv?variant=executive',
            verify: ['shasum -a 256 well-architected-2026-03-04-run-1234-executive.csv'],
          }),
        ],
      },
    ],
    taken: [],
    ...over,
  };
}

const html = (exports?: RunExports): string => renderToStaticMarkup(<RunFiles exports={exports} />);

describe('the files taken from a run', () => {
  it('puts the digest and the command that reproduces it next to the download', () => {
    const markup = html(published());

    expect(markup).toContain('/api/scans/run-1234567890/export.csv');
    expect(markup).toContain('shasum -a 256 well-architected-2026-03-04-run-1234.csv');
    expect(markup).toContain(DIGEST.slice(7));
    // The size, because a recipient checking a file they were mailed has that to compare first.
    expect(markup).toContain('41,872');
  });

  it('says who each variant is for, and what a narrower one leaves out', () => {
    // A reader choosing between four files needs to be told what they differ by, and a reader handed
    // the narrow one needs to know the whole of it exists — otherwise an absent column reads as a
    // fact the app does not record.
    const markup = html(published());

    expect(markup).toContain('every requirement, everything read to judge it');
    expect(markup).toContain('deciding what to do about the estate');
    expect(markup).toContain('in the technical export');
    expect(markup).toContain('variant=executive');
  });

  it('says the digest is not a signature, so nobody reads it as proof of who produced the file', () => {
    // The claim a checksum invites and does not support. Managed-key signatures are the other half of
    // this audit requirement and are not built; a panel that let a reader assume otherwise would be
    // worse than no panel.
    const markup = html(published());

    expect(markup).toContain('not a signature');
    expect(markup).toContain('has not changed');
  });

  it('states the reproducibility the digest depends on, rather than leaving it assumed', () => {
    // Somebody who exports twice and gets two identical files should be told that is deliberate,
    // because the alternative reading is that the app served a cached copy.
    expect(html(published())).toContain('nothing about the download');
  });

  it('names the one thing that changes a digest, so an honest mismatch is not read as tampering', () => {
    // The boundary of the claim above, and the reason this is worth a test of its own: an export
    // describes the run and the decisions standing against it, so accepting a risk changes the bytes.
    // A sender who has already quoted a digest gets a mismatch reported back, and a panel that had
    // told them mismatches mean tampering would have sent them looking for an attacker.
    const markup = html(published());

    expect(markup).toContain('Recording a decision');
    expect(markup).toContain('changes its digest');
  });

  it('lists what has already been taken, and says plainly why a copy may no longer match', () => {
    const markup = html(
      published({
        taken: [
          { name: 'well-architected-2026-03-04-run-1234.csv', digest: DIGEST, at: '2026-03-05T11:00:00.000Z', by: 'sender@example.com', current: false },
          { name: 'well-architected-2026-03-04-run-1234.json', digest: DIGEST, at: '2026-03-04T10:00:00.000Z', by: 'sender@example.com', current: true },
        ],
      })
    );

    expect(markup).toContain('sender@example.com');
    expect(markup).toContain('hashes to something else, because the record has moved');
    expect(markup).toContain('still hashes to the same value');
    // The reading the panel has to head off: a mismatch here is a decision, not an attacker.
    expect(markup).toContain('not evidence of tampering');
  });

  it('says nothing about a file this build can no longer produce, rather than calling it out of date', () => {
    // A file exported by an earlier version of this app is not a copy superseded by a decision, and
    // the two want different answers from whoever is asked about them.
    const markup = html(
      published({
        taken: [{ name: 'well-architected-2025-11-01-oldbuild.csv', digest: DIGEST, at: '2025-11-01T10:00:00.000Z', by: 'sender@example.com' }],
      })
    );

    expect(markup).toContain('no longer produces a file of that name');
    expect(markup).not.toContain('the record has moved since');
  });

  it('names its sections at level two, because the plane above them is a landmark and not a heading', () => {
    /*
     * Asserted here rather than left to `check:a11y`, which cannot reach this panel: it renders only
     * once a run has exports, and the sweep visits `/run/:id` with none. These were `h4` under a
     * plane whose name is an `aria-label`, so the outline went from the shell's `h1` to an `h4` — the
     * same skip the sweep did catch on `/months`, two levels wide, on a page it never sees. The rule
     * is on `SectionHeader`, and this is what fails when a heading here stops following it.
     */
    const markup = html(published());

    expect(markup).toContain('<h2 class="wa-label-eyebrow text-wa-text">technical</h2>');
    expect(markup).not.toMatch(/<h[3456]/);
  });

  it('renders nothing while the request is in flight or after it failed', () => {
    // An aside on a view about provenance and cost. A reader who came for those has not asked about
    // checksums, and an error box about one would be the loudest thing on the screen.
    expect(html(undefined)).toBe('');
    expect(html(published({ variants: [] }))).toBe('');
  });
});
