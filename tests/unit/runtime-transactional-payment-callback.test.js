'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeService } = require('../../services/api/src/runtime-service');

const COURT_ID = '11111111-1111-4111-8111-111111111111';
const PAYMENT_ID = '22222222-2222-4222-8222-222222222222';
const ASSESSMENT_ID = '33333333-3333-4333-8333-333333333333';

const verifiedCallback = Object.freeze({
  providerCode: 'bank.png',
  providerEventId: 'evt-100',
  paymentId: PAYMENT_ID,
  providerReference: 'TX-100',
  status: 'CONFIRMED',
  amountMinor: 12000,
  currency: 'PGK',
  occurredAt: '2026-09-07T00:00:00.000Z',
  receivedAt: '2026-09-07T00:00:01.000Z',
  bodySha256: 'a'.repeat(64)
});

function paymentRow(status = 'PENDING', providerReference = null, confirmedBy = null, confirmedAt = null) {
  return {
    payment_id: PAYMENT_ID,
    assessment_id: ASSESSMENT_ID,
    court_id: COURT_ID,
    amount_minor: 12000,
    currency: 'PGK',
    status,
    provider_code: 'bank.png',
    provider_reference: providerReference,
    created_by_subject: 'finance-maker',
    created_at: '2026-09-06T00:00:00.000Z',
    confirmed_by_subject: confirmedBy,
    confirmed_at: confirmedAt
  };
}

function callbackRow(params, processingStatus = 'RECEIVED', processedAt = null) {
  return {
    callback_event_id: params[0],
    provider_code: params[1],
    provider_event_id: params[2],
    payment_id: params[3],
    body_sha256: params[4],
    provider_reference: params[5],
    event_status: params[6],
    amount_minor: params[7],
    currency: params[8],
    occurred_at: params[9],
    received_at: params[10],
    processed_at: processedAt,
    processing_status: processingStatus
  };
}

function poolFixture({ failOutbox = false } = {}) {
  let instance = null;
  let claimedCallback = null;

  class FakePool {
    constructor(options) {
      this.options = options;
      this.calls = [];
      instance = this;
      this.client = {
        query: async (text, params = []) => {
          this.calls.push({ target: 'client', text, params });
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };

          if (/INSERT INTO integration\.payment_callback_events/i.test(text)) {
            claimedCallback = callbackRow(params);
            return { rows: [claimedCallback] };
          }

          if (/SELECT[\s\S]*provider_code[\s\S]*FROM finance\.payments WHERE payment_id=\$1/i.test(text)) {
            return { rows: [paymentRow()] };
          }

          if (/UPDATE finance\.payments[\s\S]*SET status='CONFIRMED'/i.test(text)) {
            return { rows: [paymentRow('CONFIRMED', params[1], params[2], params[3])] };
          }

          if (/INSERT INTO audit\.audit_events/i.test(text)) return { rows: [] };

          if (/INSERT INTO integration\.outbox_events/i.test(text)) {
            if (failOutbox) throw new Error('callback outbox insert failed');
            return { rows: [{
              outbox_event_id: '44444444-4444-4444-8444-444444444444',
              event_type: params[0], aggregate_type: params[1], aggregate_id: params[2],
              court_id: params[3], actor_subject: params[4], correlation_id: params[5],
              deduplication_key: params[6], payload: JSON.parse(params[7]), headers: JSON.parse(params[8]),
              status: 'PENDING', attempt_count: 0, next_attempt_at: '2026-09-07T00:00:01.000Z',
              locked_at: null, locked_by: null, last_attempt_at: null, last_error: null,
              created_at: '2026-09-07T00:00:01.000Z', delivered_at: null
            }] };
          }

          if (/UPDATE integration\.payment_callback_events[\s\S]*SET processing_status='PROCESSED'/i.test(text)) {
            return { rows: [{ ...claimedCallback, processing_status: 'PROCESSED', processed_at: params[1] }] };
          }

          throw new Error(`Unexpected client SQL: ${text}`);
        },
        release: () => this.calls.push({ target: 'client', text: 'RELEASE', params: [] })
      };
    }

    async connect() {
      this.calls.push({ target: 'pool', text: 'CONNECT', params: [] });
      return this.client;
    }

    async query(text) {
      this.calls.push({ target: 'pool', text, params: [] });
      throw new Error('Callback, payment, audit and outbox SQL must not bypass the transaction client');
    }
  }

  return { PoolClass: FakePool, getInstance: () => instance };
}

test('callback claim payment mutation audit outbox and completion share one physical PostgreSQL transaction', async () => {
  const fixture = poolFixture();
  const service = createRuntimeService({ env: { DATABASE_URL: 'postgres://example/db' }, PoolClass: fixture.PoolClass });

  const confirmed = await service.confirmPaymentFromCallback(verifiedCallback);
  assert.equal(confirmed.status, 'CONFIRMED');

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => call.text === 'BEGIN').length, 1);
  assert.equal(calls.filter(call => call.text === 'COMMIT').length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 0);
  assert.equal(calls.filter(call => /INSERT INTO integration\.payment_callback_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /UPDATE finance\.payments[\s\S]*status='CONFIRMED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO integration\.outbox_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /UPDATE integration\.payment_callback_events[\s\S]*processing_status='PROCESSED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.target === 'pool' && /INSERT|UPDATE|DELETE/i.test(call.text)).length, 0);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('callback transaction rolls back claim payment and audit work when outbox enqueue fails', async () => {
  const fixture = poolFixture({ failOutbox: true });
  const service = createRuntimeService({ env: { DATABASE_URL: 'postgres://example/db' }, PoolClass: fixture.PoolClass });

  await assert.rejects(() => service.confirmPaymentFromCallback(verifiedCallback), /callback outbox insert failed/);

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /INSERT INTO integration\.payment_callback_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /UPDATE finance\.payments[\s\S]*status='CONFIRMED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO integration\.outbox_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /UPDATE integration\.payment_callback_events[\s\S]*processing_status='PROCESSED'/i.test(call.text)).length, 0);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});
