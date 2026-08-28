// Where the app opens the first time, and where the vocabulary lives afterwards.
//
// A route rather than a modal on the overview, which was the other option and is the one most apps
// pick. Three things decided it.
//
// It can be sent to somebody. "Read this before you quote the score at the steering group" is a link
// here; it is nothing at all if the welcome is a dialog that only appears for a reader who has never
// opened the app.
//
// It can be re-read. The glossary is on it, and a reader who wants to check what this app means by
// coverage is not a first-time reader. A modal shown once and then unreachable would have put ten
// definitions somewhere nobody could get back to.
//
// And it is checked. `npm run check:a11y` and `npm run check:viewport` walk routes, so a welcome at a
// URL is measured for contrast, focus order and fit like every other page — where the same content
// inside a dialog is reached only by clearing browser storage, which is why the interposition seeds
// that storage in the sweeps rather than relying on it. See scripts/check-a11y.mjs.
//
// The bypass is a plain secondary button and it says what it does. An expert who has read this twice
// should not have to scroll to leave, and a "skip" that only scrolls the page — or worse, that is not
// offered at all until the reader reaches the bottom — is the pattern that teaches people to click
// through onboarding without reading any of it, including the app they had not seen before.

import { Link, useNavigate } from 'react-router';
import { ArrowRight, SkipForward } from 'lucide-react';
import { Orientation } from '../components/Orientation';
import { useOriented } from '../components/shell/oriented';
import { CustomerPage } from '../components/system';

export function StartPage() {
  const navigate = useNavigate();
  const { remember } = useOriented();

  return (
    <CustomerPage>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* At the top, where a reader who already knows this meets it before the first paragraph. */}
        <button
          type="button"
          className="wa-button-secondary"
          onClick={() => {
            remember();
            void navigate('/');
          }}
        >
          <SkipForward aria-hidden className="h-3.5 w-3.5" />
          Skip this, I know the product
        </button>
      </div>
      <Orientation
        onward={
          <div className="flex flex-wrap items-center gap-2">
            {/* Defining comes before running, which is the order the app now enforces — and the
                reason this is the primary action rather than "Run a scan". A scan with no definition
                behind it is the implicit assessment this product spent its first release removing. */}
            <Link className="wa-button-primary" to="/definitions/setup" onClick={remember}>
              Define an assessment
              <ArrowRight aria-hidden className="h-3.5 w-3.5" />
            </Link>
            <Link className="wa-button-secondary" to="/definitions" onClick={remember}>
              See what is already defined
            </Link>
          </div>
        }
      />
    </CustomerPage>
  );
}
