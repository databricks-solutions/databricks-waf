// What `/` is: the overview, or the welcome the first time.
//
// A redirect rather than a second thing this route can render, so `/` is the overview at every URL a
// reader can bookmark and `/start` is the welcome at every URL they can send. `replace`, because the
// reader did not navigate here and a back button that returns to a redirect is a trap.
//
// Interposed, which is the point. The complaint this closes is that a novice was asked to scan
// production before being told what the app reads or what it will not do, and a banner they can ignore
// does not answer it. What makes interposing acceptable is the bypass on the welcome itself, which is
// one button at the top of the page rather than something to be earned by scrolling — see
// pages/StartPage.tsx and components/shell/oriented.ts.
//
// Its own file rather than a function in the router, so `/` still names the page it serves. The route
// checker follows each route to the component it renders and holds the query parameters a link carries
// against that page's source; a component declared inline in App.tsx is one it cannot follow, so every
// filtered link to `/` would have gone unchecked. See scripts/check-routes.mjs.

import { Navigate } from 'react-router';
import { OverviewPage } from './OverviewPage';
import { useOriented } from '../components/shell/oriented';
import { START } from '../components/shell/nav';

export function Landing() {
  const { oriented } = useOriented();
  return oriented ? <OverviewPage /> : <Navigate to={START.to} replace />;
}
