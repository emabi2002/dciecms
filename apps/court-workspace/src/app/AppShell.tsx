import { NavLink, Outlet } from 'react-router-dom';

export function AppShell() {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header>
        <h1>DCIECMS Court Workspace</h1>
        <nav aria-label="Primary">
          <NavLink to="/">My Work</NavLink>
          <NavLink to="/filings">Filings</NavLink>
          <NavLink to="/payments">Payments</NavLink>
          <NavLink to="/cases">Cases</NavLink>
        </nav>
      </header>
      <main id="main-content">
        <Outlet />
      </main>
    </>
  );
}
