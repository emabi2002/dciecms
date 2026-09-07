'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PaymentEventProcessor } = require('../../services/api/src/payment-event-processor');

function makeFixture() {
  const payment = {
    paymentId: '11111111-1111-1111-1111-111111111111',
    assessmentId: '22222222-2222-2222-2222-222222222222',
    courtId: 'COURT-A',
    amountMinor: 12500,
    currency: 'PGK',
    status: 'PENDING',
    providerCode: 'approved-gateway',
    providerPaymentReference: 'gw-pay-1'
  };
  const counters = { confirm: 0, receipt: 0, caseOpen: 0 };
  const repo = {
    payment,
    async getPaymentProviderBinding(id) { return id === this.payment.paymentId ? { ...this.payment } : null; },
    async confirmPaymentFromProviderEvidence(input) {
      counters.confirm += 1;
      this.payment = { ...this.payment, status: 'CONFIRMED', confirmedAt: input.confirmedAt, confirmedBy: input.actorSubject };
      return { ...this.payment };
    },
    async transitionPaymentProviderOutcome() { throw new Error('not expected'); },
    async markPaymentProviderEventProcessed(input) { return { ...input, processingStatus: 'PROCESSED' }; },
    async markPaymentProviderEventRejected(input) { return { ...input, processingStatus: 'REJECTED' }; },
    async createReceipt() { counters.receipt += 1; throw new Error('provider processor must not issue receipt'); },
    async openCaseForFiling() { counters.caseOpen += 1; throw new Error('provider processor must not open case'); }
  };
  const audit = [];
  const outbox = [];
  const processor = new PaymentEventProcessor({
    repository: repo,
    auditStore: { async append(event) { audit.push(event); } },
    outboxStore: { async enqueue(event) { outbox.push(event); } },
    transactionManager: { async withTransaction(work) { return work(); } },
    clock: () => new Date('2026-09-07T01:05:00.000Z')
  });
  const event = {
    eventRecordId: '33333333-3333-3333-3333-333333333333',
    providerCode: 'approved-gateway',
    providerEventId: 'evt-1',
    providerPaymentReference: 'gw-pay-1',
    paymentId: payment.paymentId,
    normalizedEventType: 'PAYMENT_SUCCEEDED',
    amountMinor: 12500,
    currency: 'PGK',
    processingStatus: 'RECEIVED'
  };
  return { processor, repo, counters, audit, outbox, event };
}

test('provider success cannot confirm when canonical amount currency provider reference or correlation differs', async () => {
  const variants = [
    { amountMinor: 12501 },
    { currency: 'USD' },
    { providerCode: 'wrong-provider' },
    { providerPaymentReference: 'wrong-reference' },
    { paymentId: '44444444-4444-4444-4444-444444444444' }
  ];
  for (const variant of variants) {
    const { processor, repo, counters, audit, outbox, event } = makeFixture();
    const result = await processor.process({ ...event, ...variant });
    assert.equal(result.event.processingStatus, 'REJECTED');
    assert.equal(repo.payment.status, 'PENDING');
    assert.equal(counters.confirm, 0);
    assert.equal(audit.length, 0);
    assert.equal(outbox.length, 0);
  }
});

test('provider success establishes only canonical payment state and cannot issue receipt or open a case', async () => {
  const { processor, counters, audit, outbox, event } = makeFixture();
  const result = await processor.process(event);
  assert.equal(result.payment.status, 'CONFIRMED');
  assert.equal(counters.confirm, 1);
  assert.equal(counters.receipt, 0);
  assert.equal(counters.caseOpen, 0);
  assert.equal(audit.length, 1);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].eventType, 'payment.confirmed');
});

test('provider reference and provider event identity are excluded from downstream payment.confirmed payload', async () => {
  const { processor, outbox, event } = makeFixture();
  await processor.process(event);
  const serialized = JSON.stringify(outbox);
  assert.equal(serialized.includes('gw-pay-1'), false);
  assert.equal(serialized.includes('evt-1'), false);
});
