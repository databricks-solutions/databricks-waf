// The way to answer a requirement no install of this app can read.
//
// The checks page already tells a reader that a scope is "not grantable to any install of this app",
// which is true, measured (ADR 0016), and — on its own — the same dead end as a spinner. Fifty-five
// security requirements end there. The data exists and an admin can read it; what was missing was
// any way for the reader to get from that sentence to the reading.
//
// So this is the sentence with the door in it. It appears wherever the app has just said it cannot
// see something, and it says who can, what they run, and how to check the file before running it.
//
// The digest is shown rather than merely served. An admin is about to run a script from a vendor
// against production with account-admin authority, often having received the file from a colleague
// rather than downloaded it themselves — so the number they can compare against, and the two
// commands that produce it, are on the page next to the link. Publishing a checksum nobody can find
// is the same as not publishing one.

import type { EvidenceScript } from '../api/types';

export interface AdminScriptProps {
  /**
   * What the app publishes about the script, or nothing while it is still being fetched.
   *
   * Passed in rather than fetched here, like the scope preview beside it: the page owns the request
   * and this owns what it looks like, which is the half that can be asserted without a network.
   */
  readonly script?: EvidenceScript;
  /**
   * How many requirements are waiting on it, when the caller knows.
   *
   * Stated where it is known because "39 requirements need this" is what makes downloading the
   * script worth an admin's afternoon, and "some requirements" is not.
   */
  readonly waiting?: number;
}

export function AdminScript({ script: data, waiting }: AdminScriptProps) {
  // Nothing at all while it loads or if it failed. This is an aside on a page about something else,
  // and an error box about a download would be louder than the thing it interrupts. The reader loses
  // a link they did not know was coming; the page still says what it said before.
  if (data == null) return null;

  const expected = data.digest.replace(/^sha256:/, '');

  return (
    <div className="space-y-1.5">
      <p className="wa-body-compact text-wa-text-secondary">
        {waiting == null ? 'Some of these' : `${waiting} of these requirements`} can be read by an admin even though no
        install of this app can be authorised for them. This script makes those calls under their authority — read-only,
        with a dry run that prints every request and makes none of them.
      </p>

      <p>
        {/* A plain anchor rather than a router link: the target is a file, and `download` is what
            makes a browser save it instead of navigating away from the assessment to show it. */}
        <a className="wa-button-secondary" href={data.href} download={data.name}>
          Download {data.name}
        </a>
      </p>

      <p className="wa-caption">
        Version {data.version} · {data.bytes.toLocaleString()} bytes · check it before you run it:
      </p>
      <ul className="wa-caption space-y-0.5">
        {data.verify.map((line) => (
          <li key={line} className="wa-code break-all">
            {line}
          </li>
        ))}
      </ul>
      <p className="wa-caption text-wa-text-muted">
        {/* Said plainly, because the alternative is a reader assuming the checksum means more than
            it does. It establishes that the file is the one this app published; it establishes
            nothing about the estate, and the import treats what comes back as an admin's attested
            claim rather than as something this app observed. */}
        A file whose digest is not <span className="wa-code break-all">{expected}</span> is not the one this app
        published, whoever sent it.
      </p>
    </div>
  );
}
