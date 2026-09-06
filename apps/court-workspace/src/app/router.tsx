import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './AppShell';
import { MyWorkPage } from '../pages/MyWorkPage';
import { FilingsPage } from '../pages/FilingsPage';
import { FilingReviewPage } from '../pages/FilingReviewPage';
import { PaymentsPage } from '../pages/PaymentsPage';
import { CasesPage } from '../pages/CasesPage';
import { MyCasesPage } from '../pages/MyCasesPage';
import { DailyHearingsPage } from '../pages/DailyHearingsPage';
import { PendingDecisionsPage } from '../pages/PendingDecisionsPage';
import { CaseWorkspacePage } from '../pages/CaseWorkspacePage';
import { HearingModePage } from '../pages/HearingModePage';
import { NotFoundPage } from '../pages/NotFoundPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <MyWorkPage /> },
      { path: 'filings', element: <FilingsPage /> },
      { path: 'filings/:filingId', element: <FilingReviewPage /> },
      { path: 'payments', element: <PaymentsPage /> },
      { path: 'cases', element: <CasesPage /> },
      { path: 'cases/:caseId', element: <CaseWorkspacePage /> },
      { path: 'hearings/:hearingId', element: <HearingModePage /> },
      { path: 'judicial/my-cases', element: <MyCasesPage /> },
      { path: 'judicial/daily-hearings', element: <DailyHearingsPage /> },
      { path: 'judicial/pending-decisions', element: <PendingDecisionsPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
]);
