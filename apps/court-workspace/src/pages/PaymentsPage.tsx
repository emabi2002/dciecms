import { useEffect, useState } from 'react';
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
import type {
  FeeAssessment,
  Payment,
  PaymentSession,
  Receipt,
  Reconciliation,
  RefundRequest
} from '../api/types';
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

  const [refundPaymentId, setRefundPaymentId] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [requestedRefund, setRequestedRefund] = useState<RefundRequest | null>(null);
  const [refundRequestId, setRefundRequestId] = useState('');
  const [reviewedRefund, setReviewedRefund] = useState<RefundRequest | null>(null);
  const [refundDecisionReason, setRefundDecisionReason] = useState('');
  const [providerRefundReference, setProviderRefundReference] = useState('');
  const [reconciliationExceptions, setReconciliationExceptions] = useState<Reconciliation[]>([]);
  const [exceptionsError, setExceptionsError] = useState('');

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void listReconciliationExceptions(undefined, controller.signal)
      .then((items) => {
        setReconciliationExceptions(items);
        setExceptionsError('');
      })
      .catch(() => {
        if (!controller.signal.aborted) setExceptionsError('Reconciliation exceptions could not be loaded.');
      });
    return () => controller.abort();
  }, []);

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

  async function submitRefundRequest() {
    const minor = pgkToMinorUnits(refundAmount);
    if (!refundPaymentId.trim()) {
      setError('Refund payment ID is required.');
      return;
    }
    if (minor === null) {
      setError('Enter a valid positive refund amount in PGK with no more than two decimal places.');
      return;
    }
    if (!refundReason.trim()) {
      setError('Refund reason is required.');
      return;
    }
    await run(async () => {
      setRequestedRefund(await requestRefund(refundPaymentId.trim(), minor, refundReason.trim()));
    });
  }

  async function loadRefund() {
    if (!refundRequestId.trim()) {
      setError('Refund request ID is required.');
      return;
    }
    await run(async () => {
      const refund = await getRefund(refundRequestId.trim());
      setReviewedRefund(refund);
      setRefundDecisionReason('');
      setProviderRefundReference(refund.providerRefundReference || '');
    });
  }

  async function approveLoadedRefund() {
    if (!reviewedRefund) return;
    if (!refundDecisionReason.trim()) {
      setError('Refund decision reason is required.');
      return;
    }
    await run(async () => {
      setReviewedRefund(await approveRefund(reviewedRefund.refundRequestId, refundDecisionReason.trim()));
    });
  }

  async function rejectLoadedRefund() {
    if (!reviewedRefund) return;
    if (!refundDecisionReason.trim()) {
      setError('Refund decision reason is required.');
      return;
    }
    await run(async () => {
      setReviewedRefund(await rejectRefund(reviewedRefund.refundRequestId, refundDecisionReason.trim()));
    });
  }

  async function recordRefundCompletion() {
    if (!reviewedRefund) return;
    if (!providerRefundReference.trim()) {
      setError('External refund reference is required.');
      return;
    }
    await run(async () => {
      setReviewedRefund(await completeRefund(reviewedRefund.refundRequestId, providerRefundReference.trim()));
    });
  }

  return (
    <section aria-labelledby="payments-heading">
      <h2 id="payments-heading">Payments</h2>
      <p>Controlled finance progression. External payment confirmation is established only by verified provider evidence and canonical server state, never by browser-entered provider results.</p>
      {error ? <StatusMessage kind="error" message={error} /> : null}

      <section aria-labelledby="payment-processing-heading">
        <h3 id="payment-processing-heading">Fee assessment and payment</h3>
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

      <section aria-labelledby="refund-request-heading">
        <h3 id="refund-request-heading">Refund request</h3>
        <p>This records a governed refund request only. It does not execute a refund at the payment provider.</p>
        <div>
          <label htmlFor="refund-payment-id">Refund payment ID</label>
          <input id="refund-payment-id" value={refundPaymentId} onChange={(event) => setRefundPaymentId(event.target.value)} disabled={busy} />
        </div>
        <div>
          <label htmlFor="refund-amount">Refund amount (PGK)</label>
          <input id="refund-amount" inputMode="decimal" value={refundAmount} onChange={(event) => setRefundAmount(event.target.value)} disabled={busy} />
        </div>
        <div>
          <label htmlFor="refund-reason">Refund reason</label>
          <textarea id="refund-reason" value={refundReason} onChange={(event) => setRefundReason(event.target.value)} disabled={busy} />
        </div>
        <button type="button" onClick={() => void submitRefundRequest()} disabled={busy}>Request refund</button>
        {requestedRefund ? <FinanceStatus label="Refund request" status={requestedRefund.status} reference={requestedRefund.refundRequestId} /> : null}
      </section>

      <section aria-labelledby="refund-review-heading">
        <h3 id="refund-review-heading">Refund review and completion evidence</h3>
        <p>Approval and rejection are maker/checker decisions. Completion records independently obtained external refund evidence; it does not call or execute the payment provider.</p>
        <div>
          <label htmlFor="refund-request-id">Refund request ID</label>
          <input id="refund-request-id" value={refundRequestId} onChange={(event) => setRefundRequestId(event.target.value)} disabled={busy} />
        </div>
        <button type="button" onClick={() => void loadRefund()} disabled={busy}>Load refund</button>

        {reviewedRefund ? (
          <>
            <FinanceStatus label="Refund review" status={reviewedRefund.status} reference={reviewedRefund.refundRequestId} />
            {reviewedRefund.status === 'REQUESTED' ? (
              <>
                <div>
                  <label htmlFor="refund-decision-reason">Refund decision reason</label>
                  <textarea id="refund-decision-reason" value={refundDecisionReason} onChange={(event) => setRefundDecisionReason(event.target.value)} disabled={busy} />
                </div>
                <button type="button" onClick={() => void approveLoadedRefund()} disabled={busy}>Approve refund</button>
                <button type="button" onClick={() => void rejectLoadedRefund()} disabled={busy}>Reject refund</button>
              </>
            ) : null}
            {reviewedRefund.status === 'APPROVED' ? (
              <>
                <div>
                  <label htmlFor="provider-refund-reference">External refund reference</label>
                  <input id="provider-refund-reference" value={providerRefundReference} onChange={(event) => setProviderRefundReference(event.target.value)} disabled={busy} />
                </div>
                <button type="button" onClick={() => void recordRefundCompletion()} disabled={busy}>Record refund completion evidence</button>
              </>
            ) : null}
          </>
        ) : null}
      </section>

      <section aria-labelledby="reconciliation-exceptions-heading">
        <h3 id="reconciliation-exceptions-heading">Reconciliation exceptions</h3>
        <p>Court-scoped rejected or exception-marked reconciliation evidence requiring finance review.</p>
        {exceptionsError ? <StatusMessage kind="error" message={exceptionsError} /> : null}
        {reconciliationExceptions.length === 0 && !exceptionsError ? <p>No reconciliation exceptions are currently listed.</p> : null}
        {reconciliationExceptions.length > 0 ? (
          <ul>
            {reconciliationExceptions.map((item) => (
              <li key={item.reconciliationId}>
                <strong>{item.exceptionCode || item.status}</strong>
                {item.exceptionNote ? <> — <span>{item.exceptionNote}</span></> : null}
                <div>Reconciliation {item.reconciliationId}; payment {item.paymentId}; status {item.status}</div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </section>
  );
}
