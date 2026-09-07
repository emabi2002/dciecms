'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PaymentEventProcessor } = require('../../services/api/src/payment-event-processor');

const PAYMENT = Object.freeze({
  paymentId: '11111111-1111-1111-1111-111111111111',
  assessmentId: '22222222-2222-2222-2222-222222222222',
  courtId: 'COURT-A',
  amountMinor: 12500,
  currency: 'PGK',
  status: 'PENDING',
  providerCode: 'approved-gateway',
  providerPaymentReference: 'gw-pay-1',
  providerStatus: 'SESSION_CREATED',
  confirmedAt: null,
  confirmedBy: null
});

const EVENT = Object.freeze({
  eventRecordId: '33333333-3333-3333-3333-333333333333',
  providerCode: 'approved-gateway',
  providerEventId: 'evt-success-1',
  providerPaymentReference: 'gw-pay-1',
  paymentId: PAYMENT.paymentId,
  normalizedEventType: 'PAYMENT_SUCCEEDED',
  amountMinor: 12500,
  currency: 'PGK',
  processingStatus: 'RECEIVED',
  authenticatedAt: '2026-09-07T01:00:00.000Z',
  receivedAt: '2026-09-07T01:00:01.000Z'
});

function fixture({ payment = PAYMENT } = {}) {
  const calls = [];
  const repo = {
    payment: payment ? { ...payment } : null,
    confirmCalls: [],
    outcomeCalls: [],
    processedCalls: [],
    rejectedCalls: [],
    async getPaymentProviderBinding(paymentId) {
      calls.push(`get:${paymentId}`);
      return this.payment ? Object.freeze({ ...this.payment }) : null;
    },
    async confirmPaymentFromProviderEvidence(input) {
      this.confirmCalls.push({ ...input });
      this.payment = {
        ...this.payment,
        status: 'CONFIRMED',
        providerStatus: 'SUCCEEDED',
        providerConfirmedAt: input.confirmedAt,
        confirmedAt: input.confirmedAt,
        confirmedBy: input.actorSubject
      };
      return Object.freeze({ ...this.payment });
    },
    async transitionPaymentProviderOutcome(input) {
      this.outcomeCalls.push({ ...input });
      const type = input.normalizedEventType;
      if (type === 'PAYMENT_FAILED') this.payment = { ...this.payment, status: 'FAILED', providerStatus: 'FAILED', failureCode: input.resultCode };
      if (type === 'PAYMENT_CANCELLED') this.payment = { ...this.payment, status: 'CANCELLED', providerStatus: 'CANCELLED', cancelledAt: input.at };
      if (type === 'PAYMENT_REFUNDED') this.payment = { ...this.payment, status: 'REFUNDED', providerStatus: 'REFUNDED', refundedAt: input.at };
      if (type === 'PAYMENT_REVERSED') this.payment = { ...this.payment, status: 'REFUNDED', providerStatus: 'REVERSED', reversedAt: input.at };
      return Object.freeze({ ...this.payment });
    },
    async markPaymentProviderEventProcessed(input) {
      this.processedCalls.push({ ...input });
      return Object.freeze({ ...EVENT, eventRecordId: input.eventRecordId, processingStatus: 'PROCESSED', resultCode: input.resultCode, processedAt: input.processedAt });
    },
    async markPaymentProviderEventRejected(input) {
      this.rejectedCalls.push({ ...input });
      return Object.freeze({ ...EVENT, eventRecordId: input.eventRecordId, processingStatus: 'REJECTED', resultCode: input.resultCode, processedAt: input.processedAt });
    }
  };
  const auditEvents = [];
  const outboxEvents = [];
  const transactionTrace = [];
  const auditStore = { async append(event) { auditEvents.push({ ...event }); return event; } };
  const outboxStore = { async enqueue(event) { outboxEvents.push({ ...event }); return event; } };
  const transactionManager = {
    async withTransaction(work) {
      transactionTrace.push('BEGIN');
      try {
        const result = await work();
        transactionTrace.push('COMMIT');
        return result;
      } catch (error) {
        transactionTrace.push('ROLLBACK');
        throw error;
      }
    }
  };
  const processor = new PaymentEventProcessor({
    repository: repo,
    auditStore,
    outboxStore,
    transactionManager,
    clock: () => new Date('2026-09-07T01:05:00.000Z')
  });
  return { processor, repo, auditEvents, outboxEvents, transactionTrace, calls };
}

test('exact provider success confirms canonical payment and couples event audit and outbox in one transaction', async () => {
  const { processor, repo, auditEvents, outboxEvents, transactionTrace } = fixture();
  const result = await processor.process(EVENT);

  assert.equal(result.payment.status, 'CONFIRMED');
  assert.equal(result.event.processingStatus, 'PROCESSED');
  assert.equal(repo.confirmCalls.length, 1);
  assert.deepEqual(repo.confirmCalls[0], {
    paymentId: PAYMENT.paymentId,
    providerCode: 'approved-gateway',
    providerPaymentReference: 'gw-pay-1',
    amountMinor: 12500,
    currency: 'PGK',
    confirmedAt: '2026-09-07T01:05:00.000Z',
    actorSubject: 'system:payment-provider'
  });
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].action, 'finance.payment.confirm');
  assert.equal(JSON.stringify(auditEvents).includes('gw-pay-1'), false);
  assert.equal(outboxEvents.length, 1);
  assert.equal(outboxEvents[0].eventType, 'payment.confirmed');
  assert.equal(JSON.stringify(outboxEvents).includes('gw-pay-1'), false);
  assert.deepEqual(transactionTrace, ['BEGIN', 'COMMIT']);
});

test('duplicate already-processed success is a no-op for payment audit and outbox', async () => {
  const { processor, repo, auditEvents, outboxEvents } = fixture();
  const first = await processor.process(EVENT);
  const counts = { confirm: repo.confirmCalls.length, audit: auditEvents.length, outbox: outboxEvents.length };
  const second = await processor.process({ ...EVENT, processingStatus: 'PROCESSED', resultCode: 'PAYMENT_CONFIRMED' });

  assert.equal(first.payment.status, 'CONFIRMED');
  assert.equal(second.duplicate, true);
  assert.equal(repo.confirmCalls.length, counts.confirm);
  assert.equal(auditEvents.length, counts.audit);
  assert.equal(outboxEvents.length, counts.outbox);
});

test('provider reference correlation amount or currency mismatch rejects event and leaves payment pending', async () => {
  const variants = [
    { providerCode: 'other-gateway' },
    { providerPaymentReference: 'gw-other' },
    { paymentId: '44444444-4444-4444-4444-444444444444' },
    { amountMinor: 12499 },
    { currency: 'USD' }
  ];

  for (const variant of variants) {
    const { processor, repo, auditEvents, outboxEvents } = fixture();
    const result = await processor.process({ ...EVENT, ...variant });
    assert.equal(result.event.processingStatus, 'REJECTED');
    assert.equal(repo.payment.status, 'PENDING');
    assert.equal(repo.confirmCalls.length, 0);
    assert.equal(repo.rejectedCalls.length, 1);
    assert.equal(auditEvents.length, 0);
    assert.equal(outboxEvents.length, 0);
  }
});

test('success requires an eligible pending canonical payment', async () => {
  const { processor, repo, auditEvents, outboxEvents } = fixture({ payment: { ...PAYMENT, status: 'FAILED' } });
  const result = await processor.process(EVENT);
  assert.equal(result.event.processingStatus, 'REJECTED');
  assert.equal(repo.confirmCalls.length, 0);
  assert.equal(repo.payment.status, 'FAILED');
  assert.equal(auditEvents.length, 0);
  assert.equal(outboxEvents.length, 0);
});

test('failure and cancellation record canonical provider outcome but never confirm or emit payment.confirmed', async () => {
  for (const normalizedEventType of ['PAYMENT_FAILED', 'PAYMENT_CANCELLED']) {
    const { processor, repo, auditEvents, outboxEvents } = fixture();
    const event = { ...EVENT, normalizedEventType, amountMinor: null, currency: null };
    const result = await processor.process(event);

    assert.equal(result.event.processingStatus, 'PROCESSED');
    assert.equal(repo.confirmCalls.length, 0);
    assert.equal(repo.outcomeCalls.length, 1);
    assert.equal(result.payment.status, normalizedEventType === 'PAYMENT_FAILED' ? 'FAILED' : 'CANCELLED');
    assert.equal(outboxEvents.length, 0);
    assert.equal(auditEvents.length, 1);
    assert.match(auditEvents[0].action, /finance\.payment\.(fail|cancel)/);
  }
});

test('refund and reversal preserve original confirmation and historical downstream markers', async () => {
  const confirmed = {
    ...PAYMENT,
    status: 'CONFIRMED',
    providerStatus: 'SUCCEEDED',
    confirmedAt: '2026-09-07T01:01:00.000Z',
    confirmedBy: 'system:payment-provider',
    receiptId: 'receipt-existing',
    caseId: 'case-existing'
  };

  for (const normalizedEventType of ['PAYMENT_REFUNDED', 'PAYMENT_REVERSED']) {
    const { processor, repo, auditEvents, outboxEvents } = fixture({ payment: confirmed });
    const result = await processor.process({ ...EVENT, normalizedEventType, providerEventId: `evt-${normalizedEventType}` });
    assert.equal(result.event.processingStatus, 'PROCESSED');
    assert.equal(result.payment.status, 'REFUNDED');
    assert.equal(result.payment.confirmedAt, confirmed.confirmedAt);
    assert.equal(result.payment.confirmedBy, confirmed.confirmedBy);
    assert.equal(result.payment.receiptId, 'receipt-existing');
    assert.equal(result.payment.caseId, 'case-existing');
    assert.equal(repo.confirmCalls.length, 0);
    assert.equal(outboxEvents.length, 0);
    assert.equal(auditEvents.length, 1);
    assert.match(auditEvents[0].action, /finance\.payment\.(refund|reverse)/);
  }
});

test('unknown normalized event fails closed without payment mutation', async () => {
  const { processor, repo, auditEvents, outboxEvents } = fixture();
  const result = await processor.process({ ...EVENT, normalizedEventType: 'PAYMENT_UNKNOWN' });
  assert.equal(result.event.processingStatus, 'REJECTED');
  assert.equal(repo.payment.status, 'PENDING');
  assert.equal(repo.confirmCalls.length, 0);
  assert.equal(repo.outcomeCalls.length, 0);
  assert.equal(auditEvents.length, 0);
  assert.equal(outboxEvents.length, 0);
});
