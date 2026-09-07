import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentsPage } from './PaymentsPage';
import {
  assessFee,
  certifyReconciliation,
  createPayment,
  createPaymentSession,
  createReconciliation,
  issueReceipt
} from '../api/client';

vi.mock('../api/client', () => ({
  assessFee: vi.fn(),
  createPayment: vi.fn(),
  createPaymentSession: vi.fn(),
  issueReceipt: vi.fn(),
  createReconciliation: vi.fn(),
  certifyReconciliation: vi.fn()
}));

const mockedAssess = vi.mocked(assessFee);
const mockedCreatePayment = vi.mocked(createPayment);
const mockedCreateSession = vi.mocked(createPaymentSession);
const mockedReceipt = vi.mocked(issueReceipt);
const mockedReconcile = vi.mocked(createReconciliation);
const mockedCertify = vi.mocked(certifyReconciliation);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Payments and finance controls', () => {
  it('converts PGK display value to minor units for fee assessment', async () => {
    mockedAssess.mockResolvedValue({ assessmentId: 'a1', filingId: 'f1', courtId: 'c1', amountMinor: 1250, currency: 'PGK', status: 'ASSESSED' });
    render(<PaymentsPage />);

    fireEvent.change(screen.getByLabelText('Filing ID'), { target: { value: 'f1' } });
    fireEvent.change(screen.getByLabelText('Fee amount (PGK)'), { target: { value: '12.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assess fee' }));

    expect(await screen.findByText('ASSESSED')).toBeInTheDocument();
    expect(mockedAssess).toHaveBeenCalledWith('f1', 1250, 'PGK');
  });

  it('progresses a pending payment into a provider-neutral checkout session without manual provider confirmation', async () => {
    mockedAssess.mockResolvedValue({ assessmentId: 'a1', filingId: 'f1', courtId: 'c1', amountMinor: 1000, currency: 'PGK', status: 'ASSESSED' });
    mockedCreatePayment.mockResolvedValue({ paymentId: 'p1', assessmentId: 'a1', courtId: 'c1', amountMinor: 1000, currency: 'PGK', status: 'PENDING' });
    mockedCreateSession.mockResolvedValue({ checkoutUrl: 'https://checkout.example.invalid/session-a', expiresAt: null });
    render(<PaymentsPage />);

    fireEvent.change(screen.getByLabelText('Filing ID'), { target: { value: 'f1' } });
    fireEvent.change(screen.getByLabelText('Fee amount (PGK)'), { target: { value: '10.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assess fee' }));
    await screen.findByText('ASSESSED');
    fireEvent.click(screen.getByRole('button', { name: 'Create payment' }));
    expect(await screen.findByText('PENDING')).toBeInTheDocument();

    expect(screen.queryByLabelText('Provider reference')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm payment' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start secure payment' }));

    expect(mockedCreateSession).toHaveBeenCalledWith('p1');
    const link = await screen.findByRole('link', { name: 'Continue to payment provider' });
    expect(link).toHaveAttribute('href', 'https://checkout.example.invalid/session-a');
  });

  it('shows receipt and maker-checker controls when canonical payment state is already confirmed by the server', async () => {
    mockedAssess.mockResolvedValue({ assessmentId: 'a1', filingId: 'f1', courtId: 'c1', amountMinor: 1000, currency: 'PGK', status: 'ASSESSED' });
    mockedCreatePayment.mockResolvedValue({ paymentId: 'p1', assessmentId: 'a1', courtId: 'c1', amountMinor: 1000, currency: 'PGK', status: 'CONFIRMED' });
    mockedReceipt.mockResolvedValue({ receiptId: 'r1', paymentId: 'p1', courtId: 'c1', receiptNumber: 'RCPT-001', status: 'ISSUED' });
    mockedReconcile.mockResolvedValue({ reconciliationId: 'rec1', paymentId: 'p1', courtId: 'c1', status: 'PREPARED', createdBy: 'maker' });
    mockedCertify.mockResolvedValue({ reconciliationId: 'rec1', paymentId: 'p1', courtId: 'c1', status: 'CERTIFIED', createdBy: 'maker', certifiedBy: 'checker' });
    render(<PaymentsPage />);

    fireEvent.change(screen.getByLabelText('Filing ID'), { target: { value: 'f1' } });
    fireEvent.change(screen.getByLabelText('Fee amount (PGK)'), { target: { value: '10.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assess fee' }));
    await screen.findByText('ASSESSED');
    fireEvent.click(screen.getByRole('button', { name: 'Create payment' }));
    expect(await screen.findByText('CONFIRMED')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Issue receipt' }));
    expect(await screen.findByText('RCPT-001')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare reconciliation' }));
    expect(await screen.findByText('PREPARED')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Certify reconciliation' }));
    expect(await screen.findByText('CERTIFIED')).toBeInTheDocument();
  });
});
