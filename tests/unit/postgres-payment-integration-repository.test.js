'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresRepository } = require('../../services/api/src/postgres-repository');

const PAYMENT_ROW = Object.freeze({
  payment_id: '11111111-1111-1111-1111-111111111111',
  assessment_id: '22222222-2222-2222-2222-222222222222',
  court_id: '33333333-3333-3333-3333-333333333333',
  amount_minor: 12500,
  currency: 'PGK',
  status: 'PENDING',
  provider_reference: null,
  provider_code: 'approved-gateway',
  provider_payment_reference: 'gw-pay-1',
  provider_status: 'SESSION_CREATED',
  session_created_at: '2026-09-07T00:00:00.000Z',
  provider_confirmed_at: null,
  failure_code: null,
  cancelled_at: null,
  refunded_at: null,
  reversed_at: null,
  created_by_subject: 'fin-a',
  created_at: '2026-09-07T00:00:00.000Z',
  confirmed_by_subject: null,
  confirmed_at: null
});

const EVENT_ROW = Object.freeze({
  payment_provider_event_record_id: '44444444-4444-4444-4444-444444444444',
  provider_code: 'approved-gateway',
  provider_event_id: 'evt-1',
  provider_payment_reference: 'gw-pay-1',
  payment_id: PAYMENT_ROW.payment_id,
  normalized_event_type: 'PAYMENT_SUCCEEDED',
  amount_minor: 12500,
  currency: 'PGK',
  processing_status: 'RECEIVED',
  attempt_count: 0,
  max_attempts: 5,
  next_attempt_at: '2026-09-07T00:00:00.000Z',
  lease_owner: null,
  lease_expires_at: null,
  result_code: null,
  received_at: '2026-09-07T00:00:00.000Z',
  authenticated_at: '2026-09-07T00:00:00.000Z',
  processed_at: null,
  created_at: '2026-09-07T00:00:00.000Z',
  updated_at: '2026-09-07T00:00:00.000Z'
});

function dbWith(handler) {
  return { calls: [], async query(text, params = []) { this.calls.push({ text, params }); return handler(text, params, this.calls); } };
}

test('bindPaymentProviderSession conditionally binds provider identity to one pending payment', async () => {
  const db = dbWith(async text => {
    assert.match(text, /UPDATE\s+finance\.payments/i);
    assert.match(text, /status\s*=\s*'PENDING'/i);
    assert.match(text, /provider_code\s+IS\s+NULL/i);
    assert.match(text, /provider_payment_reference\s+IS\s+NULL/i);
    return { rows: [PAYMENT_ROW] };
  });
  const repo = new PostgresRepository(db);
  const payment = await repo.bindPaymentProviderSession({
    paymentId: PAYMENT_ROW.payment_id,
    providerCode: 'approved-gateway',
    providerPaymentReference: 'gw-pay-1',
    providerStatus: 'SESSION_CREATED',
    sessionCreatedAt: '2026-09-07T00:00:00.000Z'
  });
  assert.equal(payment.providerCode, 'approved-gateway');
  assert.equal(payment.providerPaymentReference, 'gw-pay-1');
  assert.equal(db.calls[0].params.includes('gw-pay-1'), true);
});

test('getPaymentProviderBinding returns canonical provider evidence without caller mutation', async () => {
  const db = dbWith(async text => {
    assert.match(text, /SELECT[\s\S]+FROM\s+finance\.payments/i);
    return { rows: [PAYMENT_ROW] };
  });
  const repo = new PostgresRepository(db);
  const payment = await repo.getPaymentProviderBinding(PAYMENT_ROW.payment_id);
  assert.equal(payment.paymentId, PAYMENT_ROW.payment_id);
  assert.equal(payment.amountMinor, 12500);
  assert.equal(payment.currency, 'PGK');
  assert.equal(payment.providerCode, 'approved-gateway');
});

test('recordPaymentProviderEvent is idempotent by provider code and provider event id', async () => {
  let insertCount = 0;
  const db = dbWith(async text => {
    if (/INSERT\s+INTO\s+finance\.payment_provider_events/i.test(text)) {
      insertCount += 1;
      assert.match(text, /ON\s+CONFLICT\s*\(provider_code\s*,\s*provider_event_id\)\s+DO\s+NOTHING/i);
      return { rows: insertCount === 1 ? [EVENT_ROW] : [] };
    }
    if (/SELECT[\s\S]+FROM\s+finance\.payment_provider_events/i.test(text)) return { rows: [EVENT_ROW] };
    throw new Error(`Unexpected SQL: ${text}`);
  });
  const repo = new PostgresRepository(db);
  const input = {
    providerCode: 'approved-gateway', providerEventId: 'evt-1', providerPaymentReference: 'gw-pay-1',
    paymentId: PAYMENT_ROW.payment_id, normalizedEventType: 'PAYMENT_SUCCEEDED', amountMinor: 12500,
    currency: 'PGK', authenticatedAt: '2026-09-07T00:00:00.000Z'
  };
  const first = await repo.recordPaymentProviderEvent(input);
  const replay = await repo.recordPaymentProviderEvent(input);
  assert.equal(first.providerEventId, 'evt-1');
  assert.deepEqual(replay, first);
});

test('confirmPaymentFromProviderEvidence requires exact bound provider reference amount and currency', async () => {
  const confirmedRow = {
    ...PAYMENT_ROW,
    status: 'CONFIRMED',
    provider_status: 'SUCCEEDED',
    provider_confirmed_at: '2026-09-07T00:05:00.000Z',
    confirmed_by_subject: 'system:payment-provider',
    confirmed_at: '2026-09-07T00:05:00.000Z'
  };
  const db = dbWith(async (text, params) => {
    assert.match(text, /UPDATE\s+finance\.payments/i);
    assert.match(text, /provider_code\s*=\s*\$/i);
    assert.match(text, /provider_payment_reference\s*=\s*\$/i);
    assert.match(text, /amount_minor\s*=\s*\$/i);
    assert.match(text, /currency\s*=\s*\$/i);
    assert.match(text, /status\s*=\s*'PENDING'/i);
    assert.equal(params.includes(12500), true);
    assert.equal(params.includes('PGK'), true);
    return { rows: [confirmedRow] };
  });
  const repo = new PostgresRepository(db);
  const result = await repo.confirmPaymentFromProviderEvidence({
    paymentId: PAYMENT_ROW.payment_id,
    providerCode: 'approved-gateway',
    providerPaymentReference: 'gw-pay-1',
    amountMinor: 12500,
    currency: 'PGK',
    confirmedAt: '2026-09-07T00:05:00.000Z',
    actorSubject: 'system:payment-provider'
  });
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.providerStatus, 'SUCCEEDED');
});

test('confirmPaymentFromProviderEvidence exposes stable integrity conflict when no canonical row matches', async () => {
  const db = dbWith(async () => ({ rows: [] }));
  const repo = new PostgresRepository(db);
  await assert.rejects(
    () => repo.confirmPaymentFromProviderEvidence({
      paymentId: PAYMENT_ROW.payment_id,
      providerCode: 'approved-gateway',
      providerPaymentReference: 'wrong-ref',
      amountMinor: 12500,
      currency: 'PGK',
      confirmedAt: '2026-09-07T00:05:00.000Z',
      actorSubject: 'system:payment-provider'
    }),
    error => error?.code === 'PAYMENT_PROVIDER_EVIDENCE_CONFLICT'
  );
});

test('transitionPaymentProviderOutcome applies only whitelisted provider outcomes and preserves confirmation evidence', async () => {
  const refunded = {
    ...PAYMENT_ROW,
    status: 'REFUNDED',
    provider_status: 'REVERSED',
    provider_confirmed_at: '2026-09-07T00:05:00.000Z',
    confirmed_by_subject: 'system:payment-provider',
    confirmed_at: '2026-09-07T00:05:00.000Z',
    reversed_at: '2026-09-07T00:10:00.000Z'
  };
  const db = dbWith(async (text, params) => {
    assert.match(text, /UPDATE\s+finance\.payments/i);
    assert.match(text, /provider_code\s*=\s*\$/i);
    assert.match(text, /provider_payment_reference\s*=\s*\$/i);
    assert.match(text, /status\s*=\s*'CONFIRMED'/i);
    assert.match(text, /reversed_at\s*=\s*\$/i);
    assert.equal(params.includes('approved-gateway'), true);
    assert.equal(params.includes('gw-pay-1'), true);
    return { rows: [refunded] };
  });
  const repo = new PostgresRepository(db);
  const result = await repo.transitionPaymentProviderOutcome({
    paymentId: PAYMENT_ROW.payment_id,
    providerCode: 'approved-gateway',
    providerPaymentReference: 'gw-pay-1',
    normalizedEventType: 'PAYMENT_REVERSED',
    at: '2026-09-07T00:10:00.000Z',
    resultCode: 'PAYMENT_REVERSED'
  });
  assert.equal(result.status, 'REFUNDED');
  assert.equal(result.providerStatus, 'REVERSED');
  assert.equal(result.confirmedAt, '2026-09-07T00:05:00.000Z');
  assert.equal(result.confirmedBy, 'system:payment-provider');
});

test('markPaymentProviderEventProcessed updates only unprocessed canonical inbox rows', async () => {
  const processed = {
    ...EVENT_ROW,
    processing_status: 'PROCESSED',
    result_code: 'PAYMENT_CONFIRMED',
    processed_at: '2026-09-07T00:10:00.000Z'
  };
  const db = dbWith(async (text, params) => {
    assert.match(text, /UPDATE\s+finance\.payment_provider_events/i);
    assert.match(text, /processing_status\s*=\s*'PROCESSED'/i);
    assert.match(text, /processing_status\s+IN\s*\(\s*'RECEIVED'\s*,\s*'PROCESSING'\s*\)/i);
    assert.equal(params.includes('PAYMENT_CONFIRMED'), true);
    return { rows: [processed] };
  });
  const repo = new PostgresRepository(db);
  const result = await repo.markPaymentProviderEventProcessed({
    eventRecordId: EVENT_ROW.payment_provider_event_record_id,
    resultCode: 'PAYMENT_CONFIRMED',
    processedAt: '2026-09-07T00:10:00.000Z'
  });
  assert.equal(result.processingStatus, 'PROCESSED');
  assert.equal(result.resultCode, 'PAYMENT_CONFIRMED');
});

test('markPaymentProviderEventRejected records only sanitized result code and closes the inbox row', async () => {
  const rejected = {
    ...EVENT_ROW,
    processing_status: 'REJECTED',
    result_code: 'PAYMENT_EVIDENCE_MISMATCH',
    processed_at: '2026-09-07T00:10:00.000Z'
  };
  const db = dbWith(async (text, params) => {
    assert.match(text, /UPDATE\s+finance\.payment_provider_events/i);
    assert.match(text, /processing_status\s*=\s*'REJECTED'/i);
    assert.match(text, /processing_status\s+IN\s*\(\s*'RECEIVED'\s*,\s*'PROCESSING'\s*\)/i);
    assert.equal(params.includes('PAYMENT_EVIDENCE_MISMATCH'), true);
    assert.equal(params.some(value => String(value).includes('gw-pay-1')), false);
    return { rows: [rejected] };
  });
  const repo = new PostgresRepository(db);
  const result = await repo.markPaymentProviderEventRejected({
    eventRecordId: EVENT_ROW.payment_provider_event_record_id,
    resultCode: 'PAYMENT_EVIDENCE_MISMATCH',
    processedAt: '2026-09-07T00:10:00.000Z'
  });
  assert.equal(result.processingStatus, 'REJECTED');
  assert.equal(result.resultCode, 'PAYMENT_EVIDENCE_MISMATCH');
});

test('payment integration repository exposes no arbitrary provider binding rewrite method', () => {
  const repo = new PostgresRepository({ async query() { return { rows: [] }; } });
  assert.equal(typeof repo.updatePaymentProviderReference, 'undefined');
  assert.equal(typeof repo.overwritePaymentProviderBinding, 'undefined');
});
