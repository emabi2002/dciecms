import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CasesPage } from './CasesPage';
import { ApiError, openCase } from '../api/client';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, openCase: vi.fn() };
});

const mockedOpenCase = vi.mocked(openCase);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Controlled case opening', () => {
  it('requires filing and confirmed payment identifiers before opening a case', () => {
    render(<CasesPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Open case' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Filing ID and confirmed payment ID are required.');
    expect(mockedOpenCase).not.toHaveBeenCalled();
  });

  it('displays exactly the case number returned by the server', async () => {
    mockedOpenCase.mockResolvedValue({
      caseId: 'case-1',
      filingId: 'filing-1',
      courtId: 'court-a',
      caseNumber: 'POM-CIV-2026-000001',
      status: 'OPEN'
    });
    render(<CasesPage />);

    expect(screen.queryByText('POM-CIV-2026-000001')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filing ID'), { target: { value: 'filing-1' } });
    fireEvent.change(screen.getByLabelText('Confirmed payment ID'), { target: { value: 'payment-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open case' }));

    expect(await screen.findByText('POM-CIV-2026-000001')).toBeInTheDocument();
    expect(mockedOpenCase).toHaveBeenCalledWith('filing-1', 'payment-1');
  });

  it('offers a retry path when case eligibility changed', async () => {
    mockedOpenCase.mockRejectedValue(new ApiError(409, 'conflict', 'case opening conflict'));
    render(<CasesPage />);

    fireEvent.change(screen.getByLabelText('Filing ID'), { target: { value: 'filing-1' } });
    fireEvent.change(screen.getByLabelText('Confirmed payment ID'), { target: { value: 'payment-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open case' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('eligibility changed');
    expect(screen.getByRole('button', { name: 'Retry case opening' })).toBeInTheDocument();
  });
});
