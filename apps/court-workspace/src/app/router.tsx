import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './AppShell';
import { MyWorkPage } from '../pages/MyWorkPage';
import { FilingsPage } from '../pages/FilingsPage';
import { PaymentsPage } from '../pages/PaymentsPage';
import { CasesPage } from '../pages/CasesPage';
import { NotFoundPage } from '../pages/NotFoundPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <MyWorkPage /> },
      { path: 'filings', element: <FilingsPage /> },
      { path: 'payments', element: <PaymentsPage /> },
      { path: 'cases', element: <CasesPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
]);
