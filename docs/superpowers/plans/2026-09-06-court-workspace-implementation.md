# DCIECMS Court Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first internal DCIECMS Court Workspace frontend over the existing tested Registry, finance, receipt/reconciliation and case-opening APIs.

**Architecture:** Add a standalone React + TypeScript + Vite application at `apps/court-workspace`. Keep the browser as a presentation client only: server responses remain authoritative for authorization, workflow transitions, finance controls, numbering and audit. Use a thin typed API client, React Router, local component state, and Vitest + Testing Library for frontend TDD.

**Tech Stack:** React 18, TypeScript 5, Vite 6, React Router 7, Vitest 3, Testing Library, jsdom, existing Node.js 20 backend and GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-06-court-workspace-design.md`

## Global Constraints

- Frontend is not an authorization boundary; all privileged actions remain enforced by the API.
- No direct browser-to-PostgreSQL access and no service-role/database secrets in browser code.
- Development `x-dev-*` identity headers may only be emitted when `VITE_DCIECMS_DEV_IDENTITY=true`.
- No global state-management library in the first slice.
- No dead navigation for unimplemented modules.
- No false success state: display success only after a successful API response.
- Treat HTTP 409 as stale/concurrent state and offer a reload path.
- Preserve keyboard navigation, semantic landmarks, accessible labels and non-color-only status messaging.
- Existing backend tests remain mandatory and CI must run backend tests, frontend tests and frontend build.

---

### Task 1: Frontend Scaffold, Test Harness and CI Contract

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Create: `apps/court-workspace/package.json`
- Create: `apps/court-workspace/tsconfig.json`
- Create: `apps/court-workspace/vite.config.ts`
- Create: `apps/court-workspace/index.html`
- Create: `apps/court-workspace/src/main.tsx`
- Create: `apps/court-workspace/src/app/App.tsx`
- Create: `apps/court-workspace/src/app/App.test.tsx`
- Create: `apps/court-workspace/src/test/setup.ts`

**Interfaces:**
- Consumes: existing root Node.js project and CI workflow.
- Produces: root scripts `test:frontend` and `build:frontend`; frontend commands `npm --prefix apps/court-workspace test -- --run` and `npm --prefix apps/court-workspace run build`.

- [ ] **Step 1: Write the failing application-shell test**

Create `apps/court-workspace/src/app/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('Court Workspace shell', () => {
  it('renders the DCIECMS Court Workspace heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /DCIECMS Court Workspace/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the frontend test and verify RED**

Run: `npm --prefix apps/court-workspace test -- --run`

Expected: FAIL because the frontend package/application does not yet exist.

- [ ] **Step 3: Add the minimal scaffold**

Create `apps/court-workspace/package.json` with scripts `dev`, `build`, `test` and dependencies `react`, `react-dom`, `react-router-dom`; devDependencies `@testing-library/jest-dom`, `@testing-library/react`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `jsdom`, `typescript`, `vite`, `vitest`.

Create `App.tsx`:

```tsx
export function App() {
  return <main><h1>DCIECMS Court Workspace</h1></main>;
}
```

Create `main.tsx` with `createRoot(document.getElementById('root')!).render(<App />)`.

Configure Vitest with jsdom and `src/test/setup.ts` importing `@testing-library/jest-dom/vitest`.

- [ ] **Step 4: Add root scripts and CI frontend gates**

Add root scripts:

```json
"test:frontend": "npm --prefix apps/court-workspace test -- --run",
"build:frontend": "npm --prefix apps/court-workspace run build"
```

Extend CI after backend `npm test`:

```yaml
- name: Install Court Workspace dependencies
  run: npm --prefix apps/court-workspace install --ignore-scripts --no-audit --no-fund
- name: Run Court Workspace tests
  run: npm run test:frontend
- name: Build Court Workspace
  run: npm run build:frontend
```

- [ ] **Step 5: Verify GREEN**

Run: `npm --prefix apps/court-workspace test -- --run`

Run: `npm --prefix apps/court-workspace run build`

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json .github/workflows/ci.yml apps/court-workspace
git commit -m "feat: scaffold Court Workspace frontend"
```

---

### Task 2: Application Shell and Routing

**Files:**
- Create: `apps/court-workspace/src/app/router.tsx`
- Create: `apps/court-workspace/src/app/AppShell.tsx`
- Create: `apps/court-workspace/src/app/AppShell.test.tsx`
- Create: `apps/court-workspace/src/pages/MyWorkPage.tsx`
- Create: `apps/court-workspace/src/pages/FilingsPage.tsx`
- Create: `apps/court-workspace/src/pages/PaymentsPage.tsx`
- Create: `apps/court-workspace/src/pages/CasesPage.tsx`
- Create: `apps/court-workspace/src/pages/NotFoundPage.tsx`
- Modify: `apps/court-workspace/src/main.tsx`

**Interfaces:**
- Produces routes `/`, `/filings`, `/payments`, `/cases` and a shared `AppShell`.
- Navigation labels are exactly `My Work`, `Filings`, `Payments`, `Cases`; Documents will be entered from filing context until a dedicated page is implemented.

- [ ] **Step 1: Write failing route/navigation tests**

Test that `AppShell` exposes one `navigation` landmark and links named My Work, Filings, Payments and Cases, and that `/missing` renders `Page not found`.

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `npm --prefix apps/court-workspace test -- --run src/app/AppShell.test.tsx`

Expected: FAIL because router/shell do not exist.

- [ ] **Step 3: Implement minimal router and shell**

Use `createBrowserRouter` and `<Outlet />`; use semantic `<header>`, `<nav aria-label="Primary">`, `<main id="main-content">`.

- [ ] **Step 4: Verify GREEN and full frontend suite**

Run targeted test, then `npm run test:frontend`.

- [ ] **Step 5: Commit**

```bash
git add apps/court-workspace/src
git commit -m "feat: add Court Workspace shell and routing"
```

---

### Task 3: Typed API Client and Error Model

**Files:**
- Create: `apps/court-workspace/src/api/types.ts`
- Create: `apps/court-workspace/src/api/client.ts`
- Create: `apps/court-workspace/src/api/client.test.ts`
- Create: `apps/court-workspace/src/config/runtime.ts`

**Interfaces:**
- Produces `ApiError`, `apiRequest<T>()`, `listRegistryFilings()`, `listWorkflowTasks()`, `getFiling()`, `validateFiling()`, `returnFiling()`, `rejectFiling()`, `acceptFiling()`, `assessFee()`, `createPayment()`, `confirmPayment()`, `issueReceipt()`, `createReconciliation()`, `certifyReconciliation()`, `openCase()`.
- `apiRequest<T>` accepts `{ method, path, body?, signal? }` and returns parsed JSON `T`.

- [ ] **Step 1: Write failing API-client tests**

Cover: relative base URL, JSON body/method, 422 message mapping, 409 `kind: 'conflict'`, 403 `kind: 'forbidden'`, and no `x-dev-*` headers when development identity is disabled.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/court-workspace test -- --run src/api/client.test.ts`

- [ ] **Step 3: Implement runtime config and client**

`runtime.ts` reads `VITE_DCIECMS_API_BASE_URL || ''` and enables dev identity only when `VITE_DCIECMS_DEV_IDENTITY === 'true'`.

`ApiError` fields: `status: number`, `kind: 'unauthenticated'|'forbidden'|'not_found'|'conflict'|'validation'|'server'|'network'`, `message: string`.

- [ ] **Step 4: Verify GREEN and full frontend suite**

Run targeted test and `npm run test:frontend`.

- [ ] **Step 5: Commit**

```bash
git add apps/court-workspace/src/api apps/court-workspace/src/config
git commit -m "feat: add Court Workspace API client"
```

---

### Task 4: My Work Dashboard and Registry Filing Queue

**Files:**
- Create: `apps/court-workspace/src/pages/MyWorkPage.test.tsx`
- Modify: `apps/court-workspace/src/pages/MyWorkPage.tsx`
- Create: `apps/court-workspace/src/pages/FilingsPage.test.tsx`
- Modify: `apps/court-workspace/src/pages/FilingsPage.tsx`
- Create: `apps/court-workspace/src/components/StatusMessage.tsx`
- Create: `apps/court-workspace/src/components/LoadingState.tsx`
- Create: `apps/court-workspace/src/components/EmptyState.tsx`

**Interfaces:**
- Dashboard consumes `listWorkflowTasks()` and `listRegistryFilings()`.
- Filings page consumes `listRegistryFilings()` and navigates to `/filings/:filingId`.

- [ ] **Step 1: Write failing dashboard tests**

Assert loading state, empty state, pending-task count, submitted-filing count and accessible error alert.

- [ ] **Step 2: Verify RED**

Run targeted dashboard test.

- [ ] **Step 3: Implement dashboard using server-derived counts only**

No locally invented workflow transitions or aggregate statuses.

- [ ] **Step 4: Write failing Registry queue tests**

Assert table headers `Filing reference`, `Case type`, `Status`, `Submitted`, and one `Open` link per filing.

- [ ] **Step 5: Implement Registry queue and verify GREEN**

Run both targeted tests, then full frontend suite.

- [ ] **Step 6: Commit**

```bash
git add apps/court-workspace/src/pages apps/court-workspace/src/components
git commit -m "feat: add My Work and Registry queue screens"
```

---

### Task 5: Filing Review and Registry Decisions

**Files:**
- Create: `apps/court-workspace/src/pages/FilingReviewPage.tsx`
- Create: `apps/court-workspace/src/pages/FilingReviewPage.test.tsx`
- Create: `apps/court-workspace/src/components/DecisionDialog.tsx`
- Modify: `apps/court-workspace/src/app/router.tsx`

**Interfaces:**
- Route: `/filings/:filingId`.
- Consumes `getFiling`, `validateFiling`, `returnFiling`, `rejectFiling`, `acceptFiling`.
- Return/reject require a non-empty reason before API invocation.

- [ ] **Step 1: Write failing review-screen tests**

Cover filing summary rendering, validate action, mandatory return reason, mandatory reject reason, accept action, and 409 conflict message containing a `Reload` button.

- [ ] **Step 2: Verify RED**

Run targeted FilingReview test.

- [ ] **Step 3: Implement minimal review workflow**

Action buttons update screen state only after API success. Disable action controls while a mutation is pending.

- [ ] **Step 4: Verify GREEN and full frontend suite**

- [ ] **Step 5: Commit**

```bash
git add apps/court-workspace/src/pages/FilingReviewPage* apps/court-workspace/src/components/DecisionDialog.tsx apps/court-workspace/src/app/router.tsx
git commit -m "feat: add Registry filing review workflow"
```

---

### Task 6: Finance, Receipt and Reconciliation Controls

**Files:**
- Create: `apps/court-workspace/src/pages/PaymentsPage.test.tsx`
- Modify: `apps/court-workspace/src/pages/PaymentsPage.tsx`
- Create: `apps/court-workspace/src/components/MoneyInput.tsx`
- Create: `apps/court-workspace/src/components/FinanceStatus.tsx`

**Interfaces:**
- Consumes `assessFee`, `createPayment`, `confirmPayment`, `issueReceipt`, `createReconciliation`, `certifyReconciliation`.
- Money input converts a validated decimal PGK display value to integer minor units before calling the API; the API remains authoritative.

- [ ] **Step 1: Write failing finance-flow tests**

Cover fee assessment, pending-payment creation, provider-reference requirement, confirmed-payment display, receipt display, and maker/checker reconciliation certification messaging.

- [ ] **Step 2: Verify RED**

Run targeted PaymentsPage test.

- [ ] **Step 3: Implement finance progression**

Use explicit state labels `ASSESSED`, `PENDING`, `CONFIRMED`; never label internal confirmation as an external gateway callback.

- [ ] **Step 4: Verify GREEN and full frontend suite**

- [ ] **Step 5: Commit**

```bash
git add apps/court-workspace/src/pages/PaymentsPage* apps/court-workspace/src/components/MoneyInput.tsx apps/court-workspace/src/components/FinanceStatus.tsx
git commit -m "feat: add Court Workspace finance controls"
```

---

### Task 7: Controlled Case Opening

**Files:**
- Create: `apps/court-workspace/src/pages/CasesPage.test.tsx`
- Modify: `apps/court-workspace/src/pages/CasesPage.tsx`
- Create: `apps/court-workspace/src/components/OpenCasePanel.tsx`

**Interfaces:**
- Consumes `openCase(filingId)`.
- Displays case number exactly as returned by the API; browser code never formats or sequences case numbers.

- [ ] **Step 1: Write failing case-opening tests**

Cover eligibility presentation, successful opening displaying returned case number, 409 stale-state recovery, and no locally generated case number.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement minimal case-opening UI**

- [ ] **Step 4: Verify GREEN and full frontend suite**

- [ ] **Step 5: Commit**

```bash
git add apps/court-workspace/src/pages/CasesPage* apps/court-workspace/src/components/OpenCasePanel.tsx
git commit -m "feat: add controlled case opening UI"
```

---

### Task 8: Accessibility, Responsive Baseline and Final CI Verification

**Files:**
- Create: `apps/court-workspace/src/styles/global.css`
- Modify: `apps/court-workspace/src/main.tsx`
- Modify: `apps/court-workspace/src/app/AppShell.tsx`
- Create: `apps/court-workspace/src/app/accessibility.test.tsx`
- Modify: `README.md`

**Interfaces:**
- Produces visible keyboard focus, responsive navigation/table overflow, non-color-only statuses, skip link, documented frontend run commands.

- [ ] **Step 1: Write failing accessibility tests**

Assert skip link targets `#main-content`, navigation landmark has an accessible name, forms expose label associations, and status/error messages use semantic roles.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Add minimal global CSS and semantic fixes**

Use system fonts, visible `:focus-visible`, max-width content container, responsive navigation wrapping and `.table-scroll { overflow-x: auto; }`; do not introduce a UI framework.

- [ ] **Step 4: Document local commands**

README commands:

```bash
npm --prefix apps/court-workspace install
npm --prefix apps/court-workspace run dev
npm run test:frontend
npm run build:frontend
```

- [ ] **Step 5: Run complete verification**

Run:

```bash
npm test
npm run test:frontend
npm run build:frontend
```

Expected: all backend tests PASS, all frontend tests PASS, frontend production build exits 0.

- [ ] **Step 6: Verify GitHub Actions on the final head**

Expected CI steps: backend tests PASS, Court Workspace tests PASS, Court Workspace build PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/court-workspace README.md
git commit -m "chore: complete Court Workspace accessibility and CI baseline"
```

## Self-Review Results

- Spec coverage: architecture, navigation, dashboard, Registry queue/review, API client, finance, receipt/reconciliation, case opening, error handling, accessibility, responsive behavior, security and CI are each mapped to tasks above.
- Placeholder scan: no TBD/TODO/"implement later" instructions are used.
- Type consistency: all screen tasks consume the API-client functions defined in Task 3; route names and case/finance action names remain consistent throughout.
- Scope: practitioner/public portals, Judicial Workbench, hearing/calendar, judgment authoring, E-Library, reports and administration remain outside this plan as required by the design spec.
