import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listPendingDecisions } from '../api/client';
import { PendingDecisionsPage } from './PendingDecisionsPage';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, listPendingDecisions: vi.fn() };
});

const mockedListPendingDecisions = vi.mocked(listPendingDecisions);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Pending Decisions Judicial Workbench', () => {
  it('renders judicial decisions awaiting action and links to the judgment workspace', async () => {
    mockedListPendingDecisions.mockResolvedValue([
      {
        judgmentId: 'judgment-1',
        caseId: 'case-1',
        hearingId: 'hearing-1',
        courtId: 'court-a',
        decisionType: 'JUDGMENT',
        title: 'Decision on liability',
        content: 'Draft reasons',
        status: 'DRAFT',
        version: 2,
        createdBy: 'mag-a',
        createdAt: '2026-09-06T01:00:00Z'
      }
    ]);

    render(
      <MemoryRouter>
        <PendingDecisionsPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Pending Decisions' })).toBeInTheDocument();
    expect(await screen.findByText('Decision on liability')).toBeInTheDocument();
    expect(screen.getByText('JUDGMENT')).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.getByText('court-a')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Decision on liability' })).toHaveAttribute('href', '/judgments/judgment-1');
    expect(mockedListPendingDecisions).toHaveBeenCalledTimes(1);
  });

  it('shows an empty-state message when no decisions are pending', async () => {
    mockedListPendingDecisions.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <PendingDecisionsPage />
      </MemoryRouter>
    );

    expect(await screen.findByText('No judicial decisions are currently awaiting your action.')).toBeInTheDocument();
  });
});
