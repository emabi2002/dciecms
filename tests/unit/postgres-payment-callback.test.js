'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresRepository } = require('../../services/api/src/postgres-repository');

class FakeQueryable {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }

  async query(text, params = []) {
    this.calls.push({ text, params });
    return this.responses.shift() || { rows: [] };
  }
}

const paymentRow = Object.freeze({
  payment_id: '11111111-1111-4111-8111-111111111111',
  assessment_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  court_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  amount_minor: '12500',
  currency: 'PGK',
  status: 'PENDING',
  provider_code: 'bank.png',
  provider_reference: null,
  created_by_subject: 'finance-maker',
  created_at: '2026-09-07T00:00:00.000Z',
  confirmed_by_subject: null,
  confirmed_at: null
});

const callbackRow = Object.freeze({
  callback_event_id: '22222222-2222-4222-8222-222222222222',
  provider_code: 'bank.png',
  provider_event_id: 'evt-100',
  payment_id: paymentRow.payment_id,
  body_sha256: 'a'.repeat(64),
  provider_reference: 'TX-100',
  event_status: 'CONFIRMED',
  amount_minor: '12500',
  currency: 'PGK',
  occurred_at: '2026-09-07T00:00:00.000Z',
  received_at: '2026-09-07T00:00:01.000Z',
  processed_at: null,
  processing_status: 'RECEIVED'
});

function claimInput() {
  return {
    callbackEventId: callbackRow.callback_event_id,
    providerCode: callbackRow.provider_code,
    providerEventId: callbackRow.provider_event_id,
    paymentId: callbackRow.payment_id,
    bodySha256: callbackRow.body_sha256,
    providerReference: callbackRow.provider_reference,
    eventStatus: callbackRow.event_status,
    amountMinor: 12500,
    currency: callbackRow.currency,
    occurredAt: callbackRow.occurred_at,
    receivedAt: callbackRow.received_at
  };
}

test('createPayment persists optional provider binding and maps it back', async () => {
  const db = new FakeQueryable([{ rows: [paymentRow] }]);
  const repo = new PostgresRepository(db);

  const payment = await repo.createPayment({
    paymentId: paymentRow.payment_id,
    assessmentId: paymentRow.assessment_id,
    courtId: paymentRow.court_id,
    amountMinor: 12500,
    currency: 'PGK',
    providerCode: 'bank.png',
    actorSubject: 'finance-maker',
    at: paymentRow.created_at
  });

  assert.equal(payment.providerCode, 'bank.png');
  assert.match(db.calls[0].text, /INSERT INTO finance\.payments[\s\S]*provider_code/i);
  assert.match(db.calls[0].text, /RETURNING[\s\S]*provider_code/i);
  assert.equal(db.calls[0].params.includes('bank.png'), true);
});

test('getPayment maps provider binding as authoritative payment evidence', async () => {
  const db = new FakeQueryable([{ rows: [paymentRow] }]);
  const repo = new PostgresRepository(db);

  const payment = await repo.getPayment(paymentRow.payment_id);

  assert.equal(payment.providerCode, 'bank.png');
  assert.match(db.calls[0].text, /SELECT[\s\S]*provider_code[\s\S]*FROM finance\.payments/i);
  assert.deepEqual(db.calls[0].params, [paymentRow.payment_id]);
});

test('claimPaymentCallback atomically claims a new provider event with parameterized conflict handling', async () => {
  const db = new FakeQueryable([{ rows: [callbackRow] }]);
  const repo = new PostgresRepository(db);

  const result = await repo.claimPaymentCallback(claimInput());

  assert.equal(result.claimed, true);
  assert.equal(result.event.providerEventId, 'evt-100');
  assert.equal(result.event.amountMinor, 12500);
  assert.equal(result.event.processingStatus, 'RECEIVED');
  assert.equal(Object.isFrozen(result.event), true);
  assert.match(db.calls[0].text, /INSERT INTO integration\.payment_callback_events/i);
  assert.match(db.calls[0].text, /ON CONFLICT\s*\(provider_code,\s*provider_event_id\)\s*DO NOTHING/i);
  assert.equal(db.calls[0].text.includes('evt-100'), false);
  assert.equal(db.calls[0].params.includes('evt-100'), true);
});

test('claimPaymentCallback returns canonical existing event after duplicate claim', async () => {
  const db = new FakeQueryable([{ rows: [] }, { rows: [callbackRow] }]);
  const repo = new PostgresRepository(db);

  const result = await repo.claimPaymentCallback(claimInput());

  assert.equal(result.claimed, false);
  assert.equal(result.event.callbackEventId, callbackRow.callback_event_id);
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[1].text, /SELECT[\s\S]*FROM integration\.payment_callback_events/i);
  assert.deepEqual(db.calls[1].params, ['bank.png', 'evt-100']);
});

test('markPaymentCallbackProcessed transitions only a received callback row', async () => {
  const processed = {
    ...callbackRow,
    processing_status: 'PROCESSED',
    processed_at: '2026-09-07T00:00:02.000Z'
  };
  const db = new FakeQueryable([{ rows: [processed] }]);
  const repo = new PostgresRepository(db);

  const result = await repo.markPaymentCallbackProcessed({
    callbackEventId: callbackRow.callback_event_id,
    processedAt: processed.processed_at
  });

  assert.equal(result.processingStatus, 'PROCESSED');
  assert.equal(result.processedAt, processed.processed_at);
  assert.match(db.calls[0].text, /SET processing_status='PROCESSED'/i);
  assert.match(db.calls[0].text, /processing_status='RECEIVED'/i);
  assert.deepEqual(db.calls[0].params, [callbackRow.callback_event_id, processed.processed_at]);
});

test('markPaymentCallbackProcessed fails closed on a stale or duplicate state transition', async () => {
  const db = new FakeQueryable([{ rows: [] }]);
  const repo = new PostgresRepository(db);

  await assert.rejects(
    () => repo.markPaymentCallbackProcessed({
      callbackEventId: callbackRow.callback_event_id,
      processedAt: '2026-09-07T00:00:02.000Z'
    }),
    (error) => error && error.code === 'PAYMENT_CALLBACK_STATE_CONFLICT'
  );
});
