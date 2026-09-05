import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';
import { NotFoundPage } from '../pages/NotFoundPage';

describe('Court Workspace routing shell', () => {
  it('exposes the primary navigation', () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<p>Dashboard</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My Work' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Filings' })).toHaveAttribute('href', '/filings');
    expect(screen.getByRole('link', { name: 'Payments' })).toHaveAttribute('href', '/payments');
    expect(screen.getByRole('link', { name: 'Cases' })).toHaveAttribute('href', '/cases');
  });

  it('renders the not-found page for an unmatched route', () => {
    render(
      <MemoryRouter initialEntries={['/missing']}>
        <Routes>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
