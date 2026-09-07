'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeService } = require('../../services/api/src/runtime-service');

const PAYMENT_ID = '11111111-1111-1111-1111-111111111111';
const EVENT_ID = '33333333-3333-3333-3333-333333333333';
const COURT_ID = '44444444-4444-4444-4444-444444444444';

const paymentRow = {
  payment_id: PAYMENT_ID,
  assessment_id: '22222222-2222-2222-2222-222222222222',
  court_id: COURT_ID,
  amount_minor: 12500,
  currency: 'PGK',
  status: 'PENDING',
  provider_reference: null,
  provider_code: 'development',
  provider_payment_reference: `dev:${PAYMENT_ID}`,
  provider_status: 'SESSION_CREATED',
  session_created_at: '2026-09-07T01:00:00.000Z',
  provider_confirmed_at: null,
  failure_code: null,
  cancelled_at: null,
  refunded_at: null,
  reversed_at: null,
  created_by_subject: 'fin-a',
  created_at: '2026-09-07T01:00:00.000Z',
  confirmed_by_subject: null,
  confirmed_at: null
};

const confirmedPaymentRow = {
  ...paymentRow,
  status: 'CONFIRMED',
  provider_status: 'SUCCEEDED',
  provider_confirmed_at: '2026-09-07T01:05:00.000Z',
  confirmed_by_subject: 'system:payment-provider',
  confirmed_at: '2026-09-07T01:05:00.000Z'
};

const receivedEventRow = {
  payment_provider_event_record_id: EVENT_ID,
  provider_code: 'development',
  provider_event_id: 'evt-success-1',
  provider_payment_reference: `dev:${PAYMENT_ID}`,
  payment_id: PAYMENT_ID,
  normalized_event_type: 'PAYMENT_SUCCEEDED',
  amount_minor: 12500,
  currency: 'PGK',
  processing_status: 'RECEIVED',
  attempt_count: 0,
  max_attempts: 5,
  next_attempt_at: '2026-09-07T01:00:00.000Z',
  lease_owner: null,
  lease_expires_at: null,
  result_code: null,
  received_at: '2026-09-07T01:00:01.000Z',
  authenticated_at: '2026-09-07T01:00:00.000Z',
  processed_at: null,
  created_at: '2026-09-07T01:00:01.000Z',
  updated_at: '2026-09-07T01:00:01.000Z'
};

const processedEventRow = {
  ...receivedEventRow,
  processing_status: 'PROCESSED',
  result_code: 'PAYMENT_CONFIRMED',
  processed_at: '2026-09-07T01:05:00.000Z',
  updated_at: '2026-09-07T01:05:00.000Z'
};

const outboxRow = {
  outbox_event_id: '55555555-5555-5555-5555-555555555555',
  event_type: 'payment.confirmed',
  aggregate_type: 'payment',
  aggregate_id: PAYMENT_ID,
  court_id: COURT_ID,
  actor_subject: 'system:payment-provider',
  correlation_id: null,
  deduplication_key: `${PAYMENT_ID}:payment.confirmed`,
  payload: JSON.stringify({ paymentId: PAYMENT_ID, courtId: COURT_ID, status: 'CONFIRMED', amountMinor: 12500, currency: 'PGK' }),
  headers: JSON.stringify({ schemaVersion: 1 }),
  status: 'PENDING',
  attempt_count: 0,
  next_attempt_at: '2026-09-07T01:05:00.000Z',
  locked_at: null,
  locked_by: null,
  last_attempt_at: null,
  last_error: null,
  created_at: '2026-09-07T01:05:00.000Z',
  delivered_at: null
};

const event = Object.freeze({
  eventRecordId: EVENT_ID,
  providerCode: 'development',
  providerEventId: 'evt-success-1',
  providerPaymentReference: `dev:${PAYMENT_ID}`,
  paymentId: PAYMENT_ID,
  normalizedEventType: 'PAYMENT_SUCCEEDED',
  amountMinor: 12500,
  currency: 'PGK',
  processingStatus: 'RECEIVED'
});

function poolFixture({ failAudit = false, failOutbox = false } = {}) {
  let instance = null;
  class FakePool {
    constructor(options) {
      this.options = options;
      this.calls = [];
      instance = this;
      this.client = {
        query: async (text, params = []) => {
          this.calls.push({ target: 'client', text, params });
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
          if (/SELECT[\s\S]+FROM\s+finance\.payment_provider_events[\s\S]+payment_provider_event_record_id\s*=\s*\$1/i.test(text)) {
            return { rows: [receivedEventRow] };
          }
          if (/SELECT[\s\S]+FROM\s+finance\.payments/i.test(text)) return { rows: [paymentRow] };
          if (/UPDATE\s+finance\.payments[\s\S]+status='CONFIRMED'/i.test(text)) return { rows: [confirmedPaymentRow] };
          if (/INSERT\s+INTO\s+audit\.audit_events/i.test(text)) {
            if (failAudit) throw new Error('audit insert failed');
            return { rows: [] };
          }
          if (/INSERT\s+INTO\s+integration\.outbox_events/i.test(text)) {
            if (failOutbox) throw new Error('outbox insert failed');
            return { rows: [outboxRow] };
          }
          if (/UPDATE\s+finance\.payment_provider_events[\s\S]+processing_status='PROCESSED'/i.test(text)) {
            return { rows: [processedEventRow] };
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
    async query(text, params = []) {
      this.calls.push({ target: 'pool', text, params });
      throw new Error('Payment provider processing SQL must not bypass the transaction client');
    }
  }
  return { PoolClass: FakePool, getInstance: () => instance };
}

function runtime(fixture) {
  return createRuntimeService({
    env: {
      DATABASE_URL: 'postgres://example/db',
      DCIECMS_PAYMENT_INTEGRATION_MODE: 'development'
    },
    PoolClass: fixture.PoolClass
  });
}

test('persistent provider success commits payment audit outbox and inbox state through one physical client', async () => {
  const fixture = poolFixture();
  const service = runtime(fixture);
  const result = await service.paymentEventProcessor.process(event);

  assert.equal(result.payment.status, 'CONFIRMED');
  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => call.text === 'BEGIN').length, 1);
  assert.equal(calls.filter(call => call.text === 'COMMIT').length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 0);
  assert.equal(calls.filter(call => /SELECT[\s\S]+FROM\s+finance\.payment_provider_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /UPDATE\s+finance\.payments/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT\s+INTO\s+audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT\s+INTO\s+integration\.outbox_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /UPDATE\s+finance\.payment_provider_events/i.test(call.text)).length, 1);
  assert.equal(calls.some(call => call.target === 'pool' && /SELECT|INSERT|UPDATE|DELETE/i.test(call.text)), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('audit failure rolls back the canonical provider-success mutation before outbox or inbox completion', async () => {
  const fixture = poolFixture({ failAudit: true });
  const service = runtime(fixture);

  await assert.rejects(() => service.paymentEventProcessor.process(event), /audit insert failed/);
  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /UPDATE\s+finance\.payments/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT\s+INTO\s+audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT\s+INTO\s+integration\.outbox_events/i.test(call.text)).length, 0);
  assert.equal(calls.filter(call => /UPDATE\s+finance\.payment_provider_events/i.test(call.text)).length, 0);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('outbox failure rolls back payment and audit before inbox completion', async () => {
  const fixture = poolFixture({ failOutbox: true });
  const service = runtime(fixture);

  await assert.rejects(() => service.paymentEventProcessor.process(event), /outbox insert failed/);
  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /UPDATE\s+finance\.payments/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT\s+INTO\s+audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT\s+INTO\s+integration\.outbox_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /UPDATE\s+finance\.payment_provider_events/i.test(call.text)).length, 0);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});
