import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilingsPage } from './FilingsPage';
import { listRegistryFilings } from '../api/client';

vi.mock('../api/client', () => ({
  listRegistryFilings: vi.fn()
}));

const mockedFilings = vi.mocked(listRegistryFilings);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Registry filing queue', () => {
  it('renders the filing queue table and Open link from server data', async () => {
    mockedFilings.mockResolvedValue([
      {
        filingId: 'filing-1',
        filingReference: 'F-001',
        courtId: 'court-a',
        caseTypeCode: 'CIVIL',
        filerPartyId: 'party-1',
        status: 'SUBMITTED',
        submittedAt: '2026-09-06T08:00:00Z'
      }
    ]);

    render(<MemoryRouter><FilingsPage /></MemoryRouter>);

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Filing reference' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Case type' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Submitted' })).toBeInTheDocument();
    expect(screen.getByText('F-001')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open F-001' })).toHaveAttribute('href', '/filings/filing-1');
  });

  it('shows an empty state when there are no Registry filings', async () => {
    mockedFilings.mockResolvedValue([]);
    render(<MemoryRouter><FilingsPage /></MemoryRouter>);
    expect(await screen.findByText('No filings are waiting in your Registry queue.')).toBeInTheDocument();
  });
});
