# DCIECMS Court Workspace Frontend Design

Date: 2026-09-06
Status: Approved architecture, implementation pending
Scope: First Court Workspace frontend application for the DCIECMS R0/R1 vertical slice

## 1. Purpose

Introduce the first production-oriented DCIECMS Court Workspace frontend without weakening the existing API authorization model. The application is for internal court and Registry/Finance users and provides an operational interface over the already-tested Registry, workflow, finance, receipt/reconciliation and case-opening backend capabilities.

The frontend is not an authorization boundary. Every privileged action remains enforced by the API using role and court-scope checks.

## 2. Recommended Architecture

Create a dedicated application at `apps/court-workspace` using:

- React
- TypeScript
- Vite
- React Router
- a thin typed API-client layer
- component-level and route-level tests

This keeps the Court Workspace decoupled from the Node API service while remaining lightweight enough for the R0/R1 implementation. It avoids prematurely adopting a heavier full-stack framework while preserving a clean path for expansion across the broader DCIECMS screen inventory.

## 3. Application Boundary

The Court Workspace owns:

- browser navigation
- screen composition
- client-side form state
- loading, empty, validation and error states
- presentation of role-aware actions
- API invocation and response rendering
- accessibility and responsive behavior

The Court Workspace does not own:

- authorization decisions
- workflow state-transition rules
- payment confirmation authority
- case-number generation
- receipt numbering
- reconciliation certification
- audit-event authority
- direct database access

Those remain server-side responsibilities.

## 4. Initial Navigation

Primary navigation for the first slice:

- My Work
- Filings
- Documents
- Payments
- Cases

The first implementation will focus only on flows supported by the current backend and will not add dead navigation for unimplemented modules.

## 5. First Screen Set

### 5.1 My Work Dashboard

Purpose: answer three questions immediately:

1. What requires my attention?
2. What am I currently working on?
3. What can I do next?

Initial dashboard cards/sections:

- pending Registry filing tasks
- submitted filings awaiting validation
- validated filings awaiting manager decision
- accepted filings awaiting fee assessment/payment progression
- confirmed payments awaiting downstream controlled actions where applicable

The dashboard is derived from server responses; no business state is manufactured by the UI.

### 5.2 Registry Filing Queue

Displays filings available within the current user's court scope.

Core fields:

- filing reference
- court
- case type
- filing status
- filer party
- submitted date/time
- task status

Primary actions depend on server-supported permissions and state:

- open filing
- validate
- return
- reject
- accept

Actions that are not valid for the current role/state are hidden or disabled for usability, but server rejection remains authoritative.

### 5.3 Filing Review

Provides a single operational review workspace for a filing.

Sections:

- filing summary
- party information
- registered document metadata
- workflow/task state
- Registry decision history/evidence available from the API
- finance state once accepted

Supported actions in the first slice:

- validate filing
- return with mandatory reason
- reject with mandatory reason
- accept validated filing
- view document metadata

Destructive or unsupported actions are excluded.

### 5.4 Finance / Payment Status

Provides controlled finance progression for accepted filings.

Supported functions:

- assess filing fee using integer minor units
- create pending payment
- record controlled payment confirmation where the actor has the required finance-manager permission
- display provider reference and payment state
- display receipt/reconciliation state when available from the current API

The UI must make maker/checker separation visible and must not imply that an internal confirmation endpoint is a live external gateway callback.

### 5.5 Case Opening

Where the backend indicates eligibility, an authorized user can invoke the controlled case-opening action after payment prerequisites are satisfied.

The UI does not create or format case numbers itself. The generated number and case record are displayed only from the API response.

## 6. API Client Design

Create one small API client module with typed functions grouped by capability rather than by page.

Initial groups:

- filings
- registry decisions
- workflow tasks
- documents
- finance/payments
- receipts/reconciliation
- cases

The client must:

- use relative/base-configured API URLs
- send JSON consistently
- surface structured API errors without exposing sensitive internals
- never embed credentials or secrets
- support request cancellation where route transitions make it useful

Development identity headers may be supported only behind an explicit development configuration path and must never be presented as production authentication.

## 7. State Management

Do not introduce a global state-management library in the first slice.

Use:

- React component state for forms and local UI state
- route-level loader/effect patterns for server data
- small reusable hooks only where repetition emerges

Server state remains authoritative. Avoid duplicating workflow state machines in the browser.

## 8. Error Handling

The UI must explicitly handle:

- 401 unauthenticated
- 403 forbidden
- 404 not found
- 409 workflow/state conflict
- 422 validation error
- 500 unexpected server failure
- network/unreachable API conditions

A 409 must be treated as a possible concurrency/stale-state event. The interface should explain that the record changed or the requested transition is no longer valid and provide a refresh/reload path.

No false success state is allowed. Actions are only shown as successful after a successful API response.

## 9. Accessibility and Responsive Requirements

The first slice must include:

- full keyboard navigation
- visible focus states
- semantic headings and landmarks
- accessible labels and validation messages
- status messaging that is not color-only
- sufficient contrast
- responsive layouts suitable for ordinary government desktop/laptop use and usable tablet widths

Data tables must remain operable on narrower screens through deliberate overflow or responsive presentation rather than clipped content.

## 10. Security Requirements

- No authorization rule may exist only in the frontend.
- No service-role, database or privileged secret is exposed to browser code.
- No direct browser-to-PostgreSQL connection.
- No sensitive metadata is written to console logs by default.
- Development identity scaffolding must be clearly isolated from production builds/configuration.
- Cross-court data must never be inferred or synthesized client-side.
- Returned server error bodies must be presented selectively to avoid accidental metadata leakage.

## 11. Testing Strategy

Use TDD for frontend behavior.

Minimum test layers:

1. API-client unit tests for request method/path/body and error mapping.
2. Component tests for loading, empty, permission-aware and validation states.
3. Route/screen tests for core Registry and Finance flows using controlled mocked API responses.
4. Accessibility-focused assertions for labels, roles and keyboard-accessible controls.
5. Existing backend tests remain mandatory and must continue to pass in CI.

The frontend build and tests will be added to GitHub Actions so PR verification covers both API and Court Workspace.

## 12. Initial Implementation Sequence

1. Scaffold `apps/court-workspace` with React + TypeScript + Vite.
2. Add frontend test tooling and CI commands.
3. Implement application shell and routing.
4. Implement API client and error model.
5. Implement My Work Dashboard.
6. Implement Registry Filing Queue.
7. Implement Filing Review and Registry decisions.
8. Implement finance/payment controls.
9. Implement receipt/reconciliation presentation/actions supported by the API.
10. Implement controlled case-opening action.
11. Complete accessibility and responsive pass.
12. Run full frontend + backend CI verification.

## 13. Deliberate Non-Scope

The first Court Workspace slice will not implement:

- practitioner/public portals
- Judicial Workbench
- full hearing/calendar module
- judgment authoring/signing UI
- reporting dashboards beyond My Work operational counts
- E-Library
- administration/configuration UI
- production SSO integration
- live payment-gateway SDKs
- external government-system integrations

These remain later releases and must not be mocked as if production-ready.

## 14. Acceptance Criteria

The architectural slice is ready for implementation when:

- the app boundary is separate from the API service
- the first navigation and screen set match currently implemented backend capabilities
- frontend actions map to existing API-enforced permissions and workflow states
- no privileged logic or secret is moved into browser code
- development identity handling is explicitly non-production
- error/concurrency/accessibility requirements are included in the test plan
- CI will run both backend and frontend verification

Implementation remains on the existing feature branch/PR unless a later branch split is deliberately chosen. No production deployment or PR merge is included in this design approval.
