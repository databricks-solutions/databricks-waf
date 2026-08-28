import { createBrowserRouter, RouterProvider, NavLink, Outlet, useNavigate } from 'react-router';
import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@databricks/appkit-ui/react';
import { Menu } from 'lucide-react';
import { Landing } from './pages/Landing';
import { OverviewPage } from './pages/OverviewPage';
import { StartPage } from './pages/StartPage';
import { PillarDetailPage, PillarsPage } from './pages/PillarsPage';
import { FindingsPage } from './pages/FindingsPage';
import { ChecksPage } from './pages/ChecksPage';
import { DefinitionsPage } from './pages/DefinitionsPage';
import { MethodologyPage } from './pages/MethodologyPage';
import { SetupPage } from './pages/SetupPage';
import { AttestationsPage } from './pages/AttestationsPage';
import { WalkPage } from './pages/WalkPage';
import { ReviewIndexPage, ReviewPage } from './pages/ReviewPage';
import { DecisionsPage } from './pages/DecisionsPage';
import { ExceptionsPage } from './pages/ExceptionsPage';
import { ImprovementsPage } from './pages/ImprovementsPage';
import { PlanPage } from './pages/PlanPage';
import { ServerlessPage } from './pages/ServerlessPage';
import { WorkloadsPage } from './pages/WorkloadsPage';
import { WarehousesPage } from './pages/WarehousesPage';
import { WritesPage } from './pages/WritesPage';
import { JobsPage } from './pages/JobsPage';
import { FoundationPage } from './pages/FoundationPage';
import { HistoryPage } from './pages/HistoryPage';
import { MonthPage, MonthsIndexPage } from './pages/MonthsPage';
import { OperatePage } from './pages/OperatePage';
import { ReportPage, RunReportPage } from './pages/ReportPage';
import { RunPage } from './pages/RunPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RetentionPage } from './pages/RetentionPage';
import { TopologyPage } from './pages/TopologyPage';
import { InvestigatePage } from './pages/InvestigatePage';
import { TrailPage } from './pages/TrailPage';
import { AdvisorProvider } from './api/advisor';
import { AssessmentProvider } from './api/assessment';
import { useAssessment } from './api/assessment-context';
import { Chrome } from './components/shell/Chrome';
import { DifferentialStrip } from './components/shell/DifferentialStrip';
import { ReviewHeader } from './components/shell/ReviewHeader';
import { useChromeColumnVisible, navigationSheetOpen, navigationSheetRequested } from './components/shell/chrome-width';
import { SkipLinks } from './components/shell/SkipLinks';
import { PRIMARY_TASKS, UTILITIES } from './components/shell/nav';
import { completedReviewPath } from './completed-review-route';

function Layout() {
  const chromeVisible = useChromeColumnVisible();
  const [mobileNavRequested, setMobileNavRequested] = useState(false);

  // The sheet is open only while it was requested and the rail is gone. Gating on the chrome
  // column — the same 900px the CSS uses — closes it on the render the rail appears, without an
  // effect that would flash the open sheet first. AppKit's `useIsMobile` is 768px, which is how
  // 768–899px had a hidden rail and no sheet either (32l).
  //
  // The request itself still has to drop when the rail returns: `onOpenChange` does not fire when
  // `open` becomes false from the gate, so a leftover true would reopen the sheet the moment the
  // viewport shrinks, and the sheet would restore focus to a trigger that is `display: none`.
  const requested = navigationSheetRequested(mobileNavRequested, chromeVisible);
  if (requested !== mobileNavRequested) setMobileNavRequested(requested);
  const mobileNavOpen = navigationSheetOpen(requested, chromeVisible);

  return (
    <div className="wa-app">
      <CompletedRunRoute />
      <SkipLinks />

      <Chrome />

      {/* min-h-0 so the scrolling region below can be shorter than its content rather than growing
          the column past the viewport, which is what would put the scrollbar back on the document. */}
      <div className="flex min-h-0 min-w-0 flex-col">
        <ReviewHeader
          menu={
            // The chrome column is gone below 900px, so the sheet is the only route to the other pages.
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavRequested}>
              <button type="button" className="wa-icon-button" onClick={() => setMobileNavRequested(true)}>
                <Menu aria-hidden className="h-4 w-4" />
                <span className="sr-only">Open navigation</span>
              </button>
              <SheetContent
                side="left"
                onCloseAutoFocus={(event) => {
                  if (chromeVisible) event.preventDefault();
                }}
              >
                <SheetHeader>
                  <SheetTitle>Navigation</SheetTitle>
                </SheetHeader>
                <nav className="flex flex-col gap-4 p-3" aria-label="Customer tasks">
                  <NavLink to="/overview" end className="wa-mobile-task" onClick={() => setMobileNavRequested(false)}>
                    <span className="col-span-2 font-semibold">Dashboard</span>
                    <span className="wa-caption col-span-2 text-wa-text-secondary">
                      Posture, coverage and the most important change across the estate
                    </span>
                  </NavLink>
                  {PRIMARY_TASKS.map((task) => (
                    <section key={task.label} className="flex flex-col gap-1">
                      <NavLink to={task.to} className="wa-mobile-task" onClick={() => setMobileNavRequested(false)}>
                        <task.icon aria-hidden className="h-4 w-4" />
                        <span className="font-semibold">{task.label}</span>
                        <span className="wa-caption col-span-2 pl-6 text-wa-text-secondary">{task.hint}</span>
                      </NavLink>
                      <div className="grid grid-cols-2 gap-1 pl-6">
                        {task.items.map((item) => (
                          <NavLink
                            key={item.to}
                            to={item.to}
                            end={item.end}
                            className="wa-mobile-view"
                            onClick={() => setMobileNavRequested(false)}
                          >
                            {item.label}
                          </NavLink>
                        ))}
                      </div>
                    </section>
                  ))}
                  <section className="flex flex-col gap-1 border-t border-wa-border pt-3">
                    <h2 className="wa-label-eyebrow px-2">Utilities</h2>
                    <div className="grid grid-cols-2 gap-1">
                      {UTILITIES.map((item) => (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          end={item.end}
                          className="wa-mobile-view"
                          onClick={() => setMobileNavRequested(false)}
                        >
                          {item.label}
                        </NavLink>
                      ))}
                    </div>
                  </section>
                </nav>
              </SheetContent>
            </Sheet>
          }
        />

        {/*
          The app's only scrolling region. The header above it and the chrome beside it never move.

          `tabIndex={-1}` so the skip link actually moves focus here rather than only scrolling the
          fragment into view, which is what a non-focusable target does — the next Tab would have gone
          back to the second skip link and the reader would still be at the top of the rail.
        */}
        <main id="content" tabIndex={-1} className="wa-canvas-scroll min-w-0">
          <Outlet />
        </main>

        {/* Below the scrolling region and outside it, which is what makes it the brief's strip
            rather than a panel at the bottom of a page: it stays while the canvas moves, and it
            says the same thing on every page because what it says is true of the assessment. */}
        <DifferentialStrip />
      </div>
    </div>
  );
}

/**
 * An interactive completion enters the exact review the server opened for that run.
 *
 * This sits inside the router while the assessment provider sits outside it. The provider owns the
 * one run lifecycle; this component owns only the route transition. Scheduled completion never sets
 * `completedReview`, so it remains visible as inbox work without hijacking another reader's page.
 */
function CompletedRunRoute() {
  const { completedReview } = useAssessment();
  const navigate = useNavigate();
  const to = completedReviewPath(completedReview);

  useEffect(() => {
    if (to != null) void navigate(to);
  }, [navigate, to]);

  return null;
}

/** Development-only design-system and customer-acceptance routes. */
const DEVELOPMENT_ROUTES = import.meta.env.DEV
  ? [
      {
        path: '/design-system',
        lazy: async () => ({ Component: (await import('./system/DesignSystemPage')).default }),
      },
      {
        path: '/preview/acceptance',
        lazy: async () => ({ Component: (await import('./system/CustomerAcceptancePage')).default }),
      },
    ]
  : [];

/** Exact production compositions with invented, read-only data for local visual acceptance. */
const CUSTOMER_PREVIEWS = import.meta.env.DEV
  ? [
      {
        path: '/preview/dashboard/:state',
        lazy: async () => ({ Component: (await import('./system/CustomerPreviewPage')).default }),
      },
      {
        path: '/preview/report/:state',
        lazy: async () => ({ Component: (await import('./system/CustomerPreviewPage')).default }),
      },
      {
        path: '/preview/investigate/:state',
        lazy: async () => ({ Component: (await import('./system/CustomerPreviewPage')).default }),
      },
      {
        path: '/preview/improvement/:state',
        lazy: async () => ({ Component: (await import('./system/CustomerPreviewPage')).default }),
      },
      {
        path: '/preview/assess/:state',
        lazy: async () => ({ Component: (await import('./system/CustomerPreviewPage')).default }),
      },
      {
        path: '/preview/operate/:state',
        lazy: async () => ({ Component: (await import('./system/CustomerPreviewPage')).default }),
      },
    ]
  : [];

const router = createBrowserRouter([
  ...DEVELOPMENT_ROUTES,
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Landing /> },
      ...CUSTOMER_PREVIEWS,
      { path: '/overview', element: <OverviewPage /> },
      { path: '/start', element: <StartPage /> },
      { path: '/pillars', element: <PillarsPage /> },
      { path: '/pillars/:pillarId', element: <PillarDetailPage /> },
      { path: '/findings', element: <FindingsPage /> },
      { path: '/topology', element: <TopologyPage /> },
      { path: '/investigate', element: <InvestigatePage /> },
      { path: '/workloads', element: <WorkloadsPage /> },
      { path: '/warehouses', element: <WarehousesPage /> },
      { path: '/writes', element: <WritesPage /> },
      { path: '/jobs', element: <JobsPage /> },
      { path: '/serverless', element: <ServerlessPage /> },
      { path: '/foundation', element: <FoundationPage /> },
      { path: '/methodology', element: <MethodologyPage /> },
      { path: '/definitions', element: <DefinitionsPage /> },
      { path: '/definitions/setup', element: <SetupPage /> },
      { path: '/checks', element: <ChecksPage /> },
      { path: '/answers', element: <AttestationsPage /> },
      { path: '/answers/walk', element: <WalkPage /> },
      { path: '/review', element: <ReviewIndexPage /> },
      { path: '/review/:reviewId', element: <ReviewPage /> },
      { path: '/decisions', element: <DecisionsPage /> },
      { path: '/exceptions', element: <ExceptionsPage /> },
      { path: '/improvements', element: <ImprovementsPage /> },
      { path: '/improvements/:planId', element: <PlanPage /> },
      { path: '/history', element: <HistoryPage /> },
      { path: '/history/:scanId', element: <RunPage /> },
      { path: '/report', element: <ReportPage /> },
      { path: '/report/:resultId', element: <RunReportPage /> },
      { path: '/operate', element: <OperatePage /> },
      { path: '/months', element: <MonthsIndexPage /> },
      { path: '/months/:month', element: <MonthPage /> },
      { path: '/diagnostics', element: <DiagnosticsPage /> },
      { path: '/trail', element: <TrailPage /> },
      { path: '/retention', element: <RetentionPage /> },
      // Last, and inside the layout rather than beside it: a reader who mistyped a path keeps the
      // header, the rail and the run controls, which is most of the way back. See NotFoundPage.
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export default function App() {
  // Both providers wrap the router rather than sitting inside the layout, so a run started on one
  // page is still the run the next page shows after navigating. Two of them rather than one because
  // the app has two run cycles and conflating them would give a reader waiting on the advisor a
  // header that says the estate is being measured — see api/advisor-context.ts.
  return (
    <AssessmentProvider>
      <AdvisorProvider>
        <RouterProvider router={router} />
      </AdvisorProvider>
    </AssessmentProvider>
  );
}
