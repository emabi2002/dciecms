import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MyWorkPage } from './MyWorkPage';
import { listRegistryFilings, listWorkflowTasks } from '../api/client';

vi.mock('../api/client', () => ({
  listRegistryFilings: vi.fn(),
  listWorkflowTasks: vi.fn()
}));

const mockedFilings = vi.mocked(listRegistryFilings);
const mockedTasks = vi.mocked(listWorkflowTasks);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('My Work dashboard', () => {
  it('shows a loading state while server data is pending', () => {
    mockedFilings.mockReturnValue(new Promise(() => {}));
    mockedTasks.mockReturnValue(new Promise(() => {}));

    render(<MyWorkPage />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading work queue');
  });

  it('shows an empty state when there is no work', async () => {
    mockedFilings.mockResolvedValue([]);
    mockedTasks.mockResolvedValue([]);

    render(<MyWorkPage />);

    expect(await screen.findByText('No work requires your attention.')).toBeInTheDocument();
  });

  it('renders server-derived pending task and submitted filing counts', async () => {
    mockedTasks.mockResolvedValue([
      { taskId: 't1', filingId: 'f1', courtId: 'c1', taskType: 'REGISTRY_VALIDATE_FILING', assignedRole: 'REG', priority: 'NORMAL', status: 'PENDING' },
      { taskId: 't2', filingId: 'f2', courtId: 'c1', taskType: 'REGISTRY_VALIDATE_FILING', assignedRole: 'REG', priority: 'NORMAL', status: 'IN_PROGRESS' }
    ]);
    mockedFilings.mockResolvedValue([
      { filingId: 'f1', filingReference: 'F-001', courtId: 'c1', caseTypeCode: 'CIVIL', filerPartyId: 'p1', status: 'SUBMITTED' }
    ]);

    render(<MyWorkPage />);

    expect(await screen.findByText('2')).toBeInTheDocument();
    expect(screen.getByText('Pending Registry tasks')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Submitted filings')).toBeInTheDocument();
  });

  it('shows an accessible alert when the work queue cannot be loaded', async () => {
    mockedTasks.mockRejectedValue(new Error('network internals'));
    mockedFilings.mockResolvedValue([]);

    render(<MyWorkPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load the work queue.');
    expect(screen.queryByText('network internals')).not.toBeInTheDocument();
  });
});
