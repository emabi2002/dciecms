import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';
import { StatusMessage } from '../components/StatusMessage';

function renderShell() {
  render(
    <MemoryRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<form><label htmlFor="case-search">Case search</label><input id="case-search" /></form>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Court Workspace accessibility baseline', () => {
  it('provides a skip link, named navigation and main landmark', () => {
    renderShell();

    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('keeps form controls associated with visible labels', () => {
    renderShell();
    expect(screen.getByLabelText('Case search')).toBeInTheDocument();
  });

  it('uses semantic status and alert roles', () => {
    const { rerender } = render(<StatusMessage message="Saved" />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    rerender(<StatusMessage kind="error" message="Unable to save" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to save');
  });
});
