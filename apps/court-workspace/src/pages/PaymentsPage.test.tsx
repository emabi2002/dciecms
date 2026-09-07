import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentsPage } from './PaymentsPage';
import {
  approveRefund,
  assessFee,
  certifyReconciliation,
  completeRefund,
  createPayment,
  createPaymentSession,
  createReconciliation,
  getRefund,
  issueReceipt,
  listReconciliationExceptions,
  rejectRefund,
  requestRefund
} from '../api/client';

vi.mock('../api/client', () => ({
  assessFee: vi.fn(),
  createPayment: vi.fn(),
  createPaymentSession: vi.fn(),
  issueReceipt: vi.fn(),
  createReconciliation: vi.fn(),
  certifyReconciliation: vi.fn(),
  requestRefund: vi.fn(),
  getRefund: vi.fn(),
  approveRefund: vi.fn(),
  rejectRefund: vi.fn(),
  completeRefund: vi.fn(),
  listReconciliationExceptions: vi.fn()
}));

const mockedAssess = vi.mocked(assessFee);
const mockedCreatePayment = vi.mocked(createPayment);
const mockedCreateSession = vi.mocked(createPaymentSession);
const mockedReceipt = vi.mocked(issueReceipt);
const mockedReconcile = vi.mocked(createReconciliation);
const mockedCertify = vi.mocked(certifyReconciliation);
const mockedRequestRefund = vi.mocked(requestRefund);
const mockedGetRefund = vi.mocked(getRefund);
const mockedApproveRefund = vi.mocked(approveRefund);
const mockedRejectRefund = vi.mocked(rejectRefund);
const mockedCompleteRefund = vi.mocked(completeRefund);
const mockedExceptions = vi.mocked(listReconciliationExceptions);

beforeEach(() => {
  vi.clearAllMocks();
  mockedExceptions.mockResolvedValue([]);
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

  it('requests a governed refund in PGK minor units and never exposes a provider execution action', async () => {
    mockedRequestRefund.mockResolvedValue({
      refundRequestId: 'refund-1', paymentId: 'p1', courtId: 'c1', amountMinor: 500,
      currency: 'PGK', reason: 'Duplicate payment', status: 'REQUESTED', requestedBy: 'fin-a'
    });
    render(<PaymentsPage />);

    fireEvent.change(screen.getByLabelText('Refund payment ID'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Refund amount (PGK)'), { target: { value: '5.00' } });
    fireEvent.change(screen.getByLabelText('Refund reason'), { target: { value: 'Duplicate payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request refund' }));

    expect(await screen.findByText('REQUESTED')).toBeInTheDocument();
    expect(mockedRequestRefund).toHaveBeenCalledWith('p1', 500, 'Duplicate payment');
    expect(screen.queryByRole('button', { name: /execute provider refund/i })).not.toBeInTheDocument();
    expect(screen.getByText(/does not execute a refund at the payment provider/i)).toBeInTheDocument();
  });

  it('supports maker-checker refund review and records provider-neutral completion evidence', async () => {
    mockedGetRefund.mockResolvedValue({
      refundRequestId: 'refund-1', paymentId: 'p1', courtId: 'c1', amountMinor: 500,
      currency: 'PGK', reason: 'Duplicate payment', status: 'REQUESTED', requestedBy: 'fin-a'
    });
    mockedApproveRefund.mockResolvedValue({
      refundRequestId: 'refund-1', paymentId: 'p1', courtId: 'c1', amountMinor: 500,
      currency: 'PGK', reason: 'Duplicate payment', status: 'APPROVED', requestedBy: 'fin-a', decidedBy: 'fin-mgr-a'
    });
    mockedCompleteRefund.mockResolvedValue({
      refundRequestId: 'refund-1', paymentId: 'p1', courtId: 'c1', amountMinor: 500,
      currency: 'PGK', reason: 'Duplicate payment', status: 'COMPLETED', requestedBy: 'fin-a',
      decidedBy: 'fin-mgr-a', providerRefundReference: 'EXT-REF-1', completedBy: 'fin-mgr-a'
    });
    render(<PaymentsPage />);

    fireEvent.change(screen.getByLabelText('Refund request ID'), { target: { value: 'refund-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load refund' }));
    expect(await screen.findByText('REQUESTED')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Refund decision reason'), { target: { value: 'Verified duplicate payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve refund' }));
    expect(await screen.findByText('APPROVED')).toBeInTheDocument();
    expect(mockedApproveRefund).toHaveBeenCalledWith('refund-1', 'Verified duplicate payment');

    fireEvent.change(screen.getByLabelText('External refund reference'), { target: { value: 'EXT-REF-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record refund completion evidence' }));
    expect(await screen.findByText('COMPLETED')).toBeInTheDocument();
    expect(mockedCompleteRefund).toHaveBeenCalledWith('refund-1', 'EXT-REF-1');
    expect(screen.queryByRole('button', { name: /execute provider refund/i })).not.toBeInTheDocument();
  });

  it('can reject a refund request with maker-checker decision evidence', async () => {
    mockedGetRefund.mockResolvedValue({
      refundRequestId: 'refund-2', paymentId: 'p2', courtId: 'c1', amountMinor: 300,
      currency: 'PGK', reason: 'Incorrect payment', status: 'REQUESTED', requestedBy: 'fin-a'
    });
    mockedRejectRefund.mockResolvedValue({
      refundRequestId: 'refund-2', paymentId: 'p2', courtId: 'c1', amountMinor: 300,
      currency: 'PGK', reason: 'Incorrect payment', status: 'REJECTED', requestedBy: 'fin-a', decidedBy: 'fin-mgr-a'
    });
    render(<PaymentsPage />);

    fireEvent.change(screen.getByLabelText('Refund request ID'), { target: { value: 'refund-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load refund' }));
    await screen.findByText('REQUESTED');
    fireEvent.change(screen.getByLabelText('Refund decision reason'), { target: { value: 'Supporting evidence incomplete' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject refund' }));

    expect(await screen.findByText('REJECTED')).toBeInTheDocument();
    expect(mockedRejectRefund).toHaveBeenCalledWith('refund-2', 'Supporting evidence incomplete');
  });

  it('loads court-scoped reconciliation exceptions for finance review', async () => {
    mockedExceptions.mockResolvedValue([
      {
        reconciliationId: 'rec-x1', paymentId: 'p9', courtId: 'c1', status: 'REJECTED',
        createdBy: 'fin-a', exceptionCode: 'BANK_MISMATCH', exceptionNote: 'Settlement total differs'
      }
    ]);
    render(<PaymentsPage />);

    expect(await screen.findByText('BANK_MISMATCH')).toBeInTheDocument();
    expect(screen.getByText('Settlement total differs')).toBeInTheDocument();
    expect(mockedExceptions).toHaveBeenCalledTimes(1);
  });
});
