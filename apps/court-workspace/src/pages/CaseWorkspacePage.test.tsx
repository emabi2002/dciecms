import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJudicialCase } from '../api/client';
import { CaseWorkspacePage } from './CaseWorkspacePage';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getJudicialCase: vi.fn() };
});

const mockedGetJudicialCase = vi.mocked(getJudicialCase);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Case Workspace Judicial Panel', () => {
  it('loads an assigned judicial case and exposes hearing work navigation', async () => {
    mockedGetJudicialCase.mockResolvedValue({
      caseId: 'case-1',
      filingId: 'filing-1',
      courtId: 'court-a',
      caseNumber: 'POM-CIVIL-2026-000001',
      caseTypeCode: 'CIVIL',
      status: 'ASSIGNED',
      assignedToSubject: 'mag-a',
      assignedBySubject: 'cmag-a',
      assignedAt: '2026-09-06T01:00:00Z'
    });

    render(
      <MemoryRouter initialEntries={['/cases/case-1']}>
        <Routes>
          <Route path="/cases/:caseId" element={<CaseWorkspacePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'POM-CIVIL-2026-000001' })).toBeInTheDocument();
    expect(screen.getByText('ASSIGNED')).toBeInTheDocument();
    expect(screen.getByText('court-a')).toBeInTheDocument();
    expect(screen.getByText('CIVIL')).toBeInTheDocument();
    expect(screen.getByText('mag-a')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View Daily Hearings' })).toHaveAttribute('href', '/judicial/daily-hearings');
    expect(mockedGetJudicialCase).toHaveBeenCalledWith('case-1', undefined, expect.any(AbortSignal));
  });

  it('shows an error when the judicial case cannot be loaded', async () => {
    mockedGetJudicialCase.mockRejectedValue(new Error('Case unavailable'));

    render(
      <MemoryRouter initialEntries={['/cases/case-1']}>
        <Routes>
          <Route path="/cases/:caseId" element={<CaseWorkspacePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('Case unavailable')).toBeInTheDocument();
  });
});
