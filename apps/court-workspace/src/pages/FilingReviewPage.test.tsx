import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilingReviewPage } from './FilingReviewPage';
import {
  ApiError,
  acceptFiling,
  getFiling,
  rejectFiling,
  returnFiling,
  validateFiling
} from '../api/client';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getFiling: vi.fn(),
    validateFiling: vi.fn(),
    returnFiling: vi.fn(),
    rejectFiling: vi.fn(),
    acceptFiling: vi.fn()
  };
});

const mockedGet = vi.mocked(getFiling);
const mockedValidate = vi.mocked(validateFiling);
const mockedReturn = vi.mocked(returnFiling);
const mockedReject = vi.mocked(rejectFiling);
const mockedAccept = vi.mocked(acceptFiling);

const filing = {
  filingId: 'filing-1',
  filingReference: 'F-001',
  courtId: 'court-a',
  caseTypeCode: 'CIVIL',
  filerPartyId: 'party-1',
  status: 'SUBMITTED'
};

function renderReview() {
  return render(
    <MemoryRouter initialEntries={['/filings/filing-1']}>
      <Routes>
        <Route path="/filings/:filingId" element={<FilingReviewPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGet.mockResolvedValue(filing);
});

describe('Filing Review', () => {
  it('renders filing summary and validates only after server success', async () => {
    mockedValidate.mockResolvedValue({ ...filing, status: 'VALIDATED' });
    renderReview();

    expect(await screen.findByRole('heading', { name: 'Filing F-001' })).toBeInTheDocument();
    expect(screen.getByText('CIVIL')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Validate filing' }));

    expect(await screen.findByText('VALIDATED')).toBeInTheDocument();
    expect(mockedValidate).toHaveBeenCalledWith('filing-1');
  });

  it('requires a reason before returning a filing', async () => {
    renderReview();
    await screen.findByRole('heading', { name: 'Filing F-001' });

    fireEvent.click(screen.getByRole('button', { name: 'Return filing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm return' }));

    expect(screen.getByRole('alert')).toHaveTextContent('A return reason is required.');
    expect(mockedReturn).not.toHaveBeenCalled();
  });

  it('requires a reason before rejecting a filing', async () => {
    renderReview();
    await screen.findByRole('heading', { name: 'Filing F-001' });

    fireEvent.click(screen.getByRole('button', { name: 'Reject filing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));

    expect(screen.getByRole('alert')).toHaveTextContent('A rejection reason is required.');
    expect(mockedReject).not.toHaveBeenCalled();
  });

  it('offers reload after a stale-state conflict', async () => {
    mockedAccept.mockRejectedValue(new ApiError(409, 'conflict', 'Filing acceptance state conflict'));
    mockedGet.mockResolvedValue({ ...filing, status: 'VALIDATED' });
    renderReview();
    await screen.findByRole('heading', { name: 'Filing F-001' });

    fireEvent.click(screen.getByRole('button', { name: 'Accept filing' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('record changed');
    expect(screen.getByRole('button', { name: 'Reload filing' })).toBeInTheDocument();
  });
});
