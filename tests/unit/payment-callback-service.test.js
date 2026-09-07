'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PersistentDciecmsService } = require('../../services/api/src/persistent-dciecms-service');
const { ConflictError, ValidationError } = require('../../services/api/src/dciecms-service');

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111';
const CALLBACK_ID = '22222222-2222-4222-8222-222222222222';
const ASSESSMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COURT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const pendingPayment = Object.freeze({
  paymentId: PAYMENT_ID,
  assessmentId: ASSESSMENT_ID,
  courtId: COURT_ID,
  amountMinor: 12500,
  currency: 'PGK',
  status: 'PENDING',
  providerCode: 'bank.png',
  providerReference: null
});

function callback(overrides = {}) {
  return Object.freeze({
    providerCode: 'bank.png',
    providerEventId: 'evt-100',
    paymentId: PAYMENT_ID,
    providerReference: 'TX-100',
    status: 'CONFIRMED',
    amountMinor: 12500,
    currency: 'PGK',
    occurredAt: '2026-09-07T00:00:00.000Z',
    receivedAt: '2026-09-07T00:00:01.000Z',
    bodySha256: 'a'.repeat(64),
    ...overrides
  });
}

function callbackEvent(overrides = {}) {
  return Object.freeze({
    callbackEventId: CALLBACK_ID,
    providerCode: 'bank.png',
    providerEventId: 'evt-100',
    paymentId: PAYMENT_ID,
    bodySha256: 'a'.repeat(64),
    providerReference: 'TX-100',
    eventStatus: 'CONFIRMED',
    amountMinor: 12500,
    currency: 'PGK',
    occurredAt: '2026-09-07T00:00:00.000Z',
    receivedAt: '2026-09-07T00:00:01.000Z',
    processedAt: null,
    processingStatus: 'RECEIVED',
    ...overrides
  });
}

function makeService({ claimed = true, event = callbackEvent(), payment = pendingPayment } = {}) {
  const calls = [];
  const auditRows = [];
  const outboxRows = [];
  const confirmed = Object.freeze({
    ...payment,
    status: 'CONFIRMED',
    providerReference: 'TX-100',
    confirmedBy: 'payment-callback:bank.png',
    confirmedAt: '2026-09-07T00:00:01.000Z'
  });
  const repository = {
    async claimPaymentCallback(input) {
      calls.push({ type: 'claim', input });
      return { claimed, event };
    },
    async getPayment(paymentId) {
      calls.push({ type: 'getPayment', paymentId });
      if (!payment || paymentId !== payment.paymentId) return null;
      if (!claimed && event.processingStatus === 'PROCESSED') {
        return Object.freeze({ ...confirmed, providerReference: event.providerReference });
      }
      return payment;
    },
    async confirmPayment(input) {
      calls.push({ type: 'confirm', input });
      return Object.freeze({ ...confirmed, providerReference: input.providerReference, confirmedBy: input.actorSubject, confirmedAt: input.at });
    },
    async markPaymentCallbackProcessed(input) {
      calls.push({ type: 'processed', input });
      return callbackEvent({ processingStatus: 'PROCESSED', processedAt: input.processedAt });
    }
  };
  const auditStore = {
    async append(row) {
      auditRows.push(Object.freeze({ ...row }));
      return row;
    }
  };
  const outboxStore = {
    async enqueue(row) {
      outboxRows.push(Object.freeze({ ...row }));
      return row;
    }
  };
  return {
    service: new PersistentDciecmsService({ repository, auditStore, outboxStore }),
    calls,
    auditRows,
    outboxRows,
    repository
  };
}

test('provider-bound payment creation passes normalized provider code to the authoritative repository', async () => {
  const created = [];
  const repository = {
    async getFeeAssessment() {
      return { assessmentId: ASSESSMENT_ID, courtId: COURT_ID, amountMinor: 12500, currency: 'PGK', status: 'ASSESSED' };
    },
    async createPayment(input) {
      created.push(input);
      return { ...pendingPayment, providerCode: input.providerCode || null };
    }
  };
  const auditStore = { async append(row) { return row; } };
  const service = new PersistentDciecmsService({ repository, auditStore });
  const actor = { userId: 'finance-maker', roles: ['FIN'], courtIds: [COURT_ID], explicitGrants: [] };

  const payment = await service.createPayment(actor, ASSESSMENT_ID, { providerCode: ' Bank.PNG ' });

  assert.equal(created[0].providerCode, 'bank.png');
  assert.equal(payment.providerCode, 'bank.png');
});

test('provider-bound payment creation maps malformed provider code to application validation failure', async () => {
  const repository = {
    async getFeeAssessment() {
      return { assessmentId: ASSESSMENT_ID, courtId: COURT_ID, amountMinor: 12500, currency: 'PGK', status: 'ASSESSED' };
    }
  };
  const service = new PersistentDciecmsService({ repository, auditStore: { async append(row) { return row; } } });
  const actor = { userId: 'finance-maker', roles: ['FIN'], courtIds: [COURT_ID], explicitGrants: [] };

  await assert.rejects(
    () => service.createPayment(actor, ASSESSMENT_ID, { providerCode: '../bank' }),
    ValidationError
  );
});

test('verified callback confirms only the matching provider-bound authoritative payment and emits safe evidence', async () => {
  const { service, calls, auditRows, outboxRows } = makeService();

  const result = await service.confirmPaymentFromCallback(callback());

  assert.equal(result.status, 'CONFIRMED');
  const confirm = calls.find(call => call.type === 'confirm');
  assert.equal(confirm.input.actorSubject, 'payment-callback:bank.png');
  assert.equal(confirm.input.providerReference, 'TX-100');
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].actorUserId, 'payment-callback:bank.png');
  assert.equal(auditRows[0].action, 'finance.payment.confirm.callback');
  assert.equal(auditRows[0].providerCode, 'bank.png');
  assert.equal(auditRows[0].providerEventId, 'evt-100');
  assert.equal(Object.prototype.hasOwnProperty.call(auditRows[0], 'bodySha256'), false);
  assert.equal(outboxRows.length, 1);
  assert.equal(outboxRows[0].eventType, 'payment.confirmed');
  assert.deepEqual(outboxRows[0].payload, {
    paymentId: PAYMENT_ID,
    courtId: COURT_ID,
    status: 'CONFIRMED',
    amountMinor: 12500,
    currency: 'PGK'
  });
  assert.equal(JSON.stringify(outboxRows[0]).includes('TX-100'), false);
  assert.equal(calls.at(-1).type, 'processed');
});

test('callback fails closed on null or mismatched provider binding', async () => {
  for (const providerCode of [null, 'other-bank']) {
    const { service } = makeService({ payment: Object.freeze({ ...pendingPayment, providerCode }) });
    await assert.rejects(() => service.confirmPaymentFromCallback(callback()), ConflictError);
  }
});

test('callback fails closed on authoritative amount or currency mismatch', async () => {
  const amountMismatch = makeService();
  await assert.rejects(
    () => amountMismatch.service.confirmPaymentFromCallback(callback({ amountMinor: 12499 })),
    ConflictError
  );

  const currencyMismatch = makeService();
  await assert.rejects(
    () => currencyMismatch.service.confirmPaymentFromCallback(callback({ currency: 'USD' })),
    ConflictError
  );
});

test('new callback cannot confirm a payment outside PENDING state', async () => {
  const { service } = makeService({ payment: Object.freeze({ ...pendingPayment, status: 'CONFIRMED', providerReference: 'OLD' }) });
  await assert.rejects(() => service.confirmPaymentFromCallback(callback()), ConflictError);
});

test('exact processed replay is idempotent and does not duplicate payment mutation audit outbox or callback completion', async () => {
  const event = callbackEvent({ processingStatus: 'PROCESSED', processedAt: '2026-09-07T00:00:02.000Z' });
  const { service, calls, auditRows, outboxRows } = makeService({ claimed: false, event });

  const result = await service.confirmPaymentFromCallback(callback());

  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.providerReference, 'TX-100');
  assert.equal(calls.filter(call => call.type === 'confirm').length, 0);
  assert.equal(calls.filter(call => call.type === 'processed').length, 0);
  assert.equal(auditRows.length, 0);
  assert.equal(outboxRows.length, 0);
});

test('conflicting provider-event replay fails closed before payment mutation', async () => {
  for (const event of [
    callbackEvent({ bodySha256: 'b'.repeat(64), processingStatus: 'PROCESSED' }),
    callbackEvent({ paymentId: '33333333-3333-4333-8333-333333333333', processingStatus: 'PROCESSED' }),
    callbackEvent({ providerReference: 'TX-OTHER', processingStatus: 'PROCESSED' })
  ]) {
    const { service, calls } = makeService({ claimed: false, event });
    await assert.rejects(() => service.confirmPaymentFromCallback(callback()), ConflictError);
    assert.equal(calls.filter(call => call.type === 'confirm').length, 0);
  }
});
