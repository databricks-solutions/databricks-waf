// A path this app does not serve.
//
// Reached by a stale bookmark, a link written by hand, or a route renamed since somebody saved it —
// `/overview` and `/plan` are both real examples, the first from a reader's guess at what the front
// page is called and the second from a page that moved under `/improvements`. Without a route to
// catch them, React Router renders its own developer error page: "Unexpected Application Error!"
// over "404 Not Found", on a white canvas, with no header, no rail and no way back. It looks like
// the app crashed, which is a worse thing for a reader to believe than that they mistyped a path.
//
// So this sits inside the shell. The header, the rail and the run controls stay where they are,
// which is most of the recovery: whatever the reader was looking for, the way to it is on screen.
//
// It is not an `EmptyState`. Those name six conditions the *estate* can be in and each carries the
// action that condition calls for; a path that does not exist is a condition of the request.

import { Link } from 'react-router';
import { CustomerPage, Surface } from '../components/system';

export function NotFoundPage() {
  const { pathname } = window.location;

  return (
    <CustomerPage>
      <Surface tone="task">
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <p className="wa-title-section text-wa-text">This app has no page at that address</p>
          <p className="wa-body-compact max-w-prose text-wa-text-secondary">
            Nothing is wrong with the app or with the run it is showing. The address{' '}
            <span className="wa-code">{pathname}</span> is not one it serves — a page may have been renamed since
            the link was saved. Everything the review holds is reachable from the rail beside this, and the
            Dashboard is the shortest way back to the current state of the estate.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            <Link to="/" className="wa-button-primary">
              Go to Dashboard
            </Link>
            <Link to="/definitions" className="wa-button-secondary">
              See what the app holds
            </Link>
          </div>
        </div>
      </Surface>
    </CustomerPage>
  );
}
