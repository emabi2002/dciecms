import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listMyCases } from '../api/client';
import { MyCasesPage } from './MyCasesPage';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, listMyCases: vi.fn() };
});

const mockedListMyCases = vi.mocked(listMyCases);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('My Cases Judicial Workbench', () => {
  it('renders the authenticated magistrate assigned cases with server-derived status', async () => {
    mockedListMyCases.mockResolvedValue([
      {
        caseId: 'case-1',
        filingId: 'filing-1',
        courtId: 'court-a',
        caseNumber: 'POM-CIVIL-2026-000001',
        status: 'ASSIGNED',
        assignedToSubject: 'mag-a'
      }
    ]);

    render(
      <MemoryRouter>
        <MyCasesPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'My Cases' })).toBeInTheDocument();
    expect(await screen.findByText('POM-CIVIL-2026-000001')).toBeInTheDocument();
    expect(screen.getByText('ASSIGNED')).toBeInTheDocument();
    expect(screen.getByText('court-a')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open POM-CIVIL-2026-000001' })).toHaveAttribute('href', '/cases/case-1');
    expect(mockedListMyCases).toHaveBeenCalledTimes(1);
  });

  it('shows an empty-state message when no cases are assigned', async () => {
    mockedListMyCases.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <MyCasesPage />
      </MemoryRouter>
    );

    expect(await screen.findByText('No cases are currently assigned to you.')).toBeInTheDocument();
  });
});
