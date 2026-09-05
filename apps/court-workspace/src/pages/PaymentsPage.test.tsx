import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentsPage } from './PaymentsPage';
import {
  assessFee,
  certifyReconciliation,
  confirmPayment,
  createPayment,
  createReconciliation,
  issueReceipt
} from '../api/client';

vi.mock('../api/client', () => ({
  assessFee: vi.fn(),
  createPayment: vi.fn(),
  confirmPayment: vi.fn(),
  issueReceipt: vi.fn(),
  createReconciliation: vi.fn(),
  certifyReconciliation: vi.fn()
}));

const mockedAssess = vi.mocked(assessFee);
const mockedCreatePayment = vi.mocked(createPayment);
const mockedConfirm = vi.mocked(confirmPayment);
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

  it('progresses assessment to pending payment and requires provider reference before confirmation', async () => {
    mockedAssess.mockResolvedValue({ assessmentId: 'a1', filingId: 'f1', courtId: 'c1', amountMinor: 1000, currency: 'PGK', status: 'ASSESSED' });
    mockedCreatePayment.mockResolvedValue({ paymentId: 'p1', assessmentId: 'a1', courtId: 'c1', amountMinor: 1000, currency: 'PGK', status: 'PENDING' });
    render(<PaymentsPage />);

    fireEvent.change(screen.getByLabelText('Filing ID'), { target: { value: 'f1' } });
    fireEvent.change(screen.getByLabelText('Fee amount (PGK)'), { target: { value: '10.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assess fee' }));
    await screen.findByText('ASSESSED');
    fireEvent.click(screen.getByRole('button', { name: 'Create payment' }));
    expect(await screen.findByText('PENDING')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm payment' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Provider reference is required.');
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('shows confirmed payment, receipt and maker-checker reconciliation responses from the server', async () => {
    mockedAssess.mockResolvedValue({ assessmentId: 'a1', filingId: 'f1', courtId: 'c1', amountMinor: 1000, currency: 'PGK', status: 'ASSESSED' });
    mockedCreatePayment.mockResolvedValue({ paymentId: 'p1', assessmentId: 'a1', courtId: 'c1', amountMinor: 1000, currency: 'PGK', status: 'PENDING' });
    mockedConfirm.mockResolvedValue({ paymentId: 'p1', assessmentId: 'a1', courtId: 'c1', amountMinor: 1000, currency: 'PGK', status: 'CONFIRMED', providerReference: 'BANK-001' });
    mockedReceipt.mockResolvedValue({ receiptId: 'r1', paymentId: 'p1', courtId: 'c1', receiptNumber: 'RCPT-001', status: 'ISSUED' });
    mockedReconcile.mockResolvedValue({ reconciliationId: 'rec1', paymentId: 'p1', courtId: 'c1', status: 'PREPARED', createdBy: 'maker' });
    mockedCertify.mockResolvedValue({ reconciliationId: 'rec1', paymentId: 'p1', courtId: 'c1', status: 'CERTIFIED', createdBy: 'maker', certifiedBy: 'checker' });
    render(<PaymentsPage />);

    fireEvent.change(screen.getByLabelText('Filing ID'), { target: { value: 'f1' } });
    fireEvent.change(screen.getByLabelText('Fee amount (PGK)'), { target: { value: '10.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assess fee' }));
    await screen.findByText('ASSESSED');
    fireEvent.click(screen.getByRole('button', { name: 'Create payment' }));
    await screen.findByText('PENDING');
    fireEvent.change(screen.getByLabelText('Provider reference'), { target: { value: 'BANK-001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm payment' }));
    expect(await screen.findByText('CONFIRMED')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Issue receipt' }));
    expect(await screen.findByText('RCPT-001')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare reconciliation' }));
    expect(await screen.findByText('PREPARED')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Certify reconciliation' }));
    expect(await screen.findByText('CERTIFIED')).toBeInTheDocument();
  });
});
