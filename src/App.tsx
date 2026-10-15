// The app shell: hash routes (so invite links like #/trip/<id> keep working), shared data, screen
// transitions, and the test panel in test mode.
import { lazy, Suspense, useLayoutEffect } from 'react';
import { createHashRouter, Outlet, RouterProvider, useLocation, useRouteError } from 'react-router-dom';
import { AppDataProvider } from './app/AppData';
import { NavMotionProvider } from './app/motion';
import { BackLink } from './components/Hero';
import { Page } from './components/Page';
import { sim } from './lib/live';
import { HomePage } from './pages/Home';
import { TripPage } from './pages/trip/TripPage';
import { EditorPage } from './pages/editor/EditorPage';
import { MembersPage } from './pages/Members';
import { AccountPage } from './pages/Account';
import { ImportSharedPage } from './pages/ImportShared';
import { ChecklistPage } from './pages/Checklist';
import { ExpensesPage } from './pages/Expenses';
import { TicketsPage } from './pages/Tickets';
import { SosPage } from './pages/Sos';
import { IdeasPage } from './pages/Ideas';
import { PollsPage } from './pages/Polls';
import { JournalPage } from './pages/Journal';
import { RecapPage } from './pages/Recap';
import { NewTripPage } from './pages/NewTrip';

// Test mode only: never downloaded otherwise.
const TestKit = sim.enabled ? lazy(() => import('./app/TestKit')) : null;
const SimBanner = sim.enabled ? lazy(() => import('./app/TestKit').then((m) => ({ default: m.SimBanner }))) : null;

function Shell() {
  const { pathname } = useLocation();
  // Every screen starts at the top.
  useLayoutEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [pathname]);
  return (
    <AppDataProvider>
      <NavMotionProvider>
        {SimBanner ? <Suspense fallback={null}><SimBanner /></Suspense> : null}
        {/* A new screen per address, so nothing carries over from the last trip. */}
        <Outlet key={pathname} />
        {TestKit ? <Suspense fallback={null}><TestKit /></Suspense> : null}
      </NavMotionProvider>
    </AppDataProvider>
  );
}

function RouteError() {
  const err = useRouteError();
  console.error(err);
  return (
    <Page viewId="view-error" hero={{ title: 'Something went wrong', nav: <BackLink /> }}>
      <section className="ed-card">
        <p className="fine">{(err as Error)?.message || 'Something went wrong.'}</p>
        <div><button className="btn" type="button" onClick={() => location.reload()}>Reload</button></div>
      </section>
    </Page>
  );
}

const router = createHashRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'trip/:id', element: <TripPage /> },
          { path: 'edit', element: <EditorPage /> },
          { path: 'edit/:id', element: <EditorPage /> },
          { path: 'members/:id', element: <MembersPage /> },
          { path: 'account', element: <AccountPage /> },
          { path: 'import/:payload', element: <ImportSharedPage /> },
          { path: 'checklist/:id', element: <ChecklistPage /> },
          { path: 'expenses/:id', element: <ExpensesPage /> },
          { path: 'tickets/:id', element: <TicketsPage /> },
          { path: 'sos/:id', element: <SosPage /> },
          { path: 'ideas/:id', element: <IdeasPage /> },
          { path: 'polls/:id', element: <PollsPage /> },
          { path: 'journal/:id', element: <JournalPage /> },
          { path: 'recap/:id', element: <RecapPage /> },
          { path: 'new', element: <NewTripPage /> },
          { path: '*', element: <HomePage /> },
        ],
      },
    ],
  },
], {
  // Opt in to React Router v7 behaviour now (none of it changes how this app works).
  future: { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true },
});

export function App() {
  return <RouterProvider router={router} future={{ v7_startTransition: true }} />;
}
