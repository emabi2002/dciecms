import { useEffect, useState } from 'react';
import {
  approveRefund,
  assessFee,
  assessFeeBySchedule,
  certifyReconciliation,
  completeRefund,
  createPayment,
  createPaymentSession,
  createReconciliation,
  getRefund,
  issueReceipt,
  listFinancePayments,
  listReconciliationExceptions,
  listRefunds,
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
  const [feeScheduleId, setFeeScheduleId] = useState('');
  const [assessment, setAssessment] = useState<FeeAssessment | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [paymentSession, setPaymentSession] = useState<PaymentSession | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);

  const [paymentQueue, setPaymentQueue] = useState<Payment[]>([]);
  const [refundQueue, setRefundQueue] = useState<RefundRequest[]>([]);
  const [queuesError, setQueuesError] = useState('');

  const [refundPaymentId, setRefundPaymentId] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [requestedRefund, setRequestedRefund] = useState<RefundRequest | null>(null);
  const [refundRequestId, setRefundRequestId] = useState('');
  const [reviewedRefund, setReviewedRefund] = useState<RefundRequest | null>(null);
  const [refundDecisionReason, setRefundDecisionReason] = useState('');
  const [providerRefundReference, setProviderRefundReference] = useState('');
  const [makerCheckerConfirmed, setMakerCheckerConfirmed] = useState(false);
  const [completionEvidenceConfirmed, setCompletionEvidenceConfirmed] = useState(false);

  const [reconciliationExceptions, setReconciliationExceptions] = useState<Reconciliation[]>([]);
  const [exceptionsError, setExceptionsError] = useState('');

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void listFinancePayments()
      .then((items) => {
        setPaymentQueue(items);
        setQueuesError('');
      })
      .catch(() => setQueuesError('Finance queues could not be loaded.'));
    void listRefunds('REQUESTED')
      .then((items) => {
        setRefundQueue(items);
        setQueuesError('');
      })
      .catch(() => setQueuesError('Finance queues could not be loaded.'));
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

  function clearPaymentProgression() {
    setPayment(null);
    setPaymentSession(null);
    setReceipt(null);
    setReconciliation(null);
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
      clearPaymentProgression();
    });
  }

  async function assessFromSchedule() {
    if (!filingId.trim()) {
      setError('Filing ID is required.');
      return;
    }
    if (!feeScheduleId.trim()) {
      setError('Fee schedule ID is required.');
      return;
    }
    await run(async () => {
      setAssessment(await assessFeeBySchedule(filingId.trim(), feeScheduleId.trim()));
      clearPaymentProgression();
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
      const refund = await requestRefund(refundPaymentId.trim(), minor, refundReason.trim());
      setRequestedRefund(refund);
      if (refund.status === 'REQUESTED') setRefundQueue((items) => [refund, ...items.filter((item) => item.refundRequestId !== refund.refundRequestId)]);
    });
  }

  async function loadRefundById(id: string) {
    await run(async () => {
      const refund = await getRefund(id);
      setRefundRequestId(id);
      setReviewedRefund(refund);
      setRefundDecisionReason('');
      setProviderRefundReference(refund.providerRefundReference || '');
      setMakerCheckerConfirmed(false);
      setCompletionEvidenceConfirmed(false);
    });
  }

  async function loadRefund() {
    if (!refundRequestId.trim()) {
      setError('Refund request ID is required.');
      return;
    }
    await loadRefundById(refundRequestId.trim());
  }

  async function approveLoadedRefund() {
    if (!reviewedRefund || !makerCheckerConfirmed) return;
    if (!refundDecisionReason.trim()) {
      setError('Refund decision reason is required.');
      return;
    }
    await run(async () => {
      const updated = await approveRefund(reviewedRefund.refundRequestId, refundDecisionReason.trim());
      setReviewedRefund(updated);
      setMakerCheckerConfirmed(false);
      setRefundQueue((items) => items.filter((item) => item.refundRequestId !== updated.refundRequestId));
    });
  }

  async function rejectLoadedRefund() {
    if (!reviewedRefund || !makerCheckerConfirmed) return;
    if (!refundDecisionReason.trim()) {
      setError('Refund decision reason is required.');
      return;
    }
    await run(async () => {
      const updated = await rejectRefund(reviewedRefund.refundRequestId, refundDecisionReason.trim());
      setReviewedRefund(updated);
      setMakerCheckerConfirmed(false);
      setRefundQueue((items) => items.filter((item) => item.refundRequestId !== updated.refundRequestId));
    });
  }

  async function recordRefundCompletion() {
    if (!reviewedRefund || !completionEvidenceConfirmed) return;
    if (!providerRefundReference.trim()) {
      setError('External refund reference is required.');
      return;
    }
    await run(async () => {
      setReviewedRefund(await completeRefund(reviewedRefund.refundRequestId, providerRefundReference.trim()));
      setCompletionEvidenceConfirmed(false);
    });
  }

  return (
    <section aria-labelledby="payments-heading">
      <h2 id="payments-heading">Payments</h2>
      <p>Controlled finance progression. External payment confirmation is established only by verified provider evidence and canonical server state, never by browser-entered provider results.</p>
      {error ? <StatusMessage kind="error" message={error} /> : null}

      <section aria-labelledby="collections-heading">
        <h3 id="collections-heading">Collections / payment status</h3>
        <p>Audited, server-side court-scoped payment status view.</p>
        {queuesError ? <StatusMessage kind="error" message={queuesError} /> : null}
        {paymentQueue.length === 0 && !queuesError ? <p>No payments are currently listed.</p> : null}
        {paymentQueue.length > 0 ? (
          <ul>
            {paymentQueue.map((item) => (
              <li key={item.paymentId}>
                <strong>{item.paymentId}</strong> — {item.status}; {item.currency} {(item.amountMinor / 100).toFixed(2)}
                {item.createdBy ? <div>Recorded by {item.createdBy}</div> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="refund-queue-heading">
        <h3 id="refund-queue-heading">Refund approval queue</h3>
        <p>REQUESTED refunds awaiting independent maker/checker review.</p>
        {refundQueue.length === 0 && !queuesError ? <p>No refund approvals are currently pending.</p> : null}
        {refundQueue.length > 0 ? (
          <ul>
            {refundQueue.map((item) => (
              <li key={item.refundRequestId}>
                <strong>{item.refundRequestId}</strong> — {item.status}; {item.currency} {(item.amountMinor / 100).toFixed(2)}
                <div>Requested by {item.requestedBy || 'unknown maker'}</div>
                <button type="button" onClick={() => void loadRefundById(item.refundRequestId)} disabled={busy}>
                  Review refund {item.refundRequestId}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="payment-processing-heading">
        <h3 id="payment-processing-heading">Fee assessment and payment</h3>
        <div>
          <label htmlFor="finance-filing-id">Filing ID</label>
          <input id="finance-filing-id" value={filingId} onChange={(event) => setFilingId(event.target.value)} disabled={busy} />
        </div>
        <div>
          <label htmlFor="fee-schedule-id">Fee schedule ID</label>
          <input id="fee-schedule-id" value={feeScheduleId} onChange={(event) => setFeeScheduleId(event.target.value)} disabled={busy} />
        </div>
        <button type="button" onClick={() => void assessFromSchedule()} disabled={busy}>Assess from fee schedule</button>
        <p>When a fee schedule is selected, the authoritative fee schedule determines the amount and currency; browser-entered money is not accepted for that path.</p>

        <MoneyInput value={amount} onChange={setAmount} disabled={busy} />
        <button type="button" onClick={() => void assess()} disabled={busy}>Assess fee</button>
        <p>The manual assessment path remains available for controlled legacy or exceptional processing and records no fee-schedule provenance.</p>

        {assessment ? (
          <>
            <FinanceStatus label="Fee assessment" status={assessment.status} reference={assessment.assessmentId} />
            {assessment.feeScheduleId ? <p>Fee schedule: {assessment.feeScheduleId}</p> : null}
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
            <p>Maker: {reviewedRefund.requestedBy || 'unknown'}</p>
            <p>Checker: {reviewedRefund.decidedBy || 'pending independent decision'}</p>
            {reviewedRefund.status === 'REQUESTED' ? (
              <>
                <div>
                  <label htmlFor="refund-decision-reason">Refund decision reason</label>
                  <textarea id="refund-decision-reason" value={refundDecisionReason} onChange={(event) => setRefundDecisionReason(event.target.value)} disabled={busy} />
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={makerCheckerConfirmed}
                    onChange={(event) => setMakerCheckerConfirmed(event.target.checked)}
                    disabled={busy}
                  />
                  I confirm independent maker-checker review
                </label>
                <button type="button" onClick={() => void approveLoadedRefund()} disabled={busy || !makerCheckerConfirmed || !refundDecisionReason.trim()}>Approve refund</button>
                <button type="button" onClick={() => void rejectLoadedRefund()} disabled={busy || !makerCheckerConfirmed || !refundDecisionReason.trim()}>Reject refund</button>
              </>
            ) : null}
            {reviewedRefund.status === 'APPROVED' ? (
              <>
                <div>
                  <label htmlFor="provider-refund-reference">External refund reference</label>
                  <input id="provider-refund-reference" value={providerRefundReference} onChange={(event) => setProviderRefundReference(event.target.value)} disabled={busy} />
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={completionEvidenceConfirmed}
                    onChange={(event) => setCompletionEvidenceConfirmed(event.target.checked)}
                    disabled={busy}
                  />
                  I confirm this records external refund evidence only
                </label>
                <button
                  type="button"
                  onClick={() => void recordRefundCompletion()}
                  disabled={busy || !completionEvidenceConfirmed || !providerRefundReference.trim()}
                >
                  Record refund completion evidence
                </button>
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
