import { useState } from 'react';
import {
  assessFee,
  certifyReconciliation,
  createPayment,
  createPaymentSession,
  createReconciliation,
  issueReceipt
} from '../api/client';
import type { FeeAssessment, Payment, PaymentSession, Receipt, Reconciliation } from '../api/types';
import { FinanceStatus } from '../components/FinanceStatus';
import { MoneyInput, pgkToMinorUnits } from '../components/MoneyInput';
import { StatusMessage } from '../components/StatusMessage';

export function PaymentsPage() {
  const [filingId, setFilingId] = useState('');
  const [amount, setAmount] = useState('');
  const [assessment, setAssessment] = useState<FeeAssessment | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [paymentSession, setPaymentSession] = useState<PaymentSession | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch {
      setError('The finance action could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  async function assess() {
    const minor = pgkToMinorUnits(amount);
    if (!filingId.trim()) {
      setError('Filing ID is required.');
      return;
    }
    if (minor === null) {
      setError('Enter a valid positive PGK amount with no more than two decimal places.');
      return;
    }
    await run(async () => {
      setAssessment(await assessFee(filingId.trim(), minor, 'PGK'));
      setPayment(null);
      setPaymentSession(null);
      setReceipt(null);
      setReconciliation(null);
    });
  }

  async function makePayment() {
    if (!assessment) return;
    await run(async () => {
      setPaymentSession(null);
      setPayment(await createPayment(assessment.assessmentId));
    });
  }

  async function startPaymentSession() {
    if (!payment) return;
    await run(async () => setPaymentSession(await createPaymentSession(payment.paymentId)));
  }

  async function makeReceipt() {
    if (!payment) return;
    await run(async () => setReceipt(await issueReceipt(payment.paymentId)));
  }

  async function prepareReconciliation() {
    if (!payment) return;
    await run(async () => setReconciliation(await createReconciliation(payment.paymentId)));
  }

  async function certify() {
    if (!reconciliation) return;
    await run(async () => setReconciliation(await certifyReconciliation(reconciliation.reconciliationId)));
  }

  return (
    <section aria-labelledby="payments-heading">
      <h2 id="payments-heading">Payments</h2>
      <p>Controlled finance progression. External payment confirmation is established only by verified provider evidence and canonical server state, never by browser-entered provider results.</p>
      {error ? <StatusMessage kind="error" message={error} /> : null}

      <div>
        <label htmlFor="finance-filing-id">Filing ID</label>
        <input id="finance-filing-id" value={filingId} onChange={(event) => setFilingId(event.target.value)} disabled={busy} />
      </div>
      <MoneyInput value={amount} onChange={setAmount} disabled={busy} />
      <button type="button" onClick={() => void assess()} disabled={busy}>Assess fee</button>

      {assessment ? (
        <>
          <FinanceStatus label="Fee assessment" status={assessment.status} reference={assessment.assessmentId} />
          <button type="button" onClick={() => void makePayment()} disabled={busy || Boolean(payment)}>Create payment</button>
        </>
      ) : null}

      {payment ? (
        <>
          <FinanceStatus label="Payment" status={payment.status} reference={payment.providerReference || payment.paymentId} />
          {payment.status === 'PENDING' ? (
            <>
              <button type="button" onClick={() => void startPaymentSession()} disabled={busy || Boolean(paymentSession)}>Start secure payment</button>
              {paymentSession ? (
                <p><a href={paymentSession.checkoutUrl}>Continue to payment provider</a></p>
              ) : null}
            </>
          ) : null}
          {payment.status === 'CONFIRMED' ? (
            <>
              <button type="button" onClick={() => void makeReceipt()} disabled={busy || Boolean(receipt)}>Issue receipt</button>
              <button type="button" onClick={() => void prepareReconciliation()} disabled={busy || Boolean(reconciliation)}>Prepare reconciliation</button>
            </>
          ) : null}
        </>
      ) : null}

      {receipt ? <FinanceStatus label="Receipt" status={receipt.status} reference={receipt.receiptNumber} /> : null}

      {reconciliation ? (
        <>
          <FinanceStatus label="Reconciliation" status={reconciliation.status} reference={reconciliation.reconciliationId} />
          {reconciliation.status === 'PREPARED' ? (
            <button type="button" onClick={() => void certify()} disabled={busy}>Certify reconciliation</button>
          ) : null}
          <p>Reconciliation certification is a maker/checker control and may require a different authorized user.</p>
        </>
      ) : null}
    </section>
  );
}
