'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PostgresPaymentCallbackStore
} = require('../../services/api/src/postgres-payment-callback-store');

const CALLBACK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PAYMENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DIGEST = 'a'.repeat(64);

class FakeQueryable {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }

  async query(text, params = []) {
    this.calls.push({ text, params });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return next || { rows: [] };
  }
}

function callbackInput(overrides = {}) {
  return {
    provider:'BANK',
    eventId:'evt-1',
    eventType:'PAYMENT_SUCCEEDED',
    paymentReference:PAYMENT_ID,
    providerPaymentReference:'gw-1',
    amountMinor:12500,
    currency:'PGK',
    occurredAt:'2026-09-07T03:00:00.000Z',
    ...overrides
  };
}

function callbackRow(overrides = {}) {
  return {
    callback_id:CALLBACK_ID,
    provider:'BANK',
    provider_event_id:'evt-1',
    event_type:'PAYMENT_SUCCEEDED',
    payment_reference:PAYMENT_ID,
    provider_payment_reference:'gw-1',
    amount_minor:'12500',
    currency:'PGK',
    occurred_at:'2026-09-07T03:00:00.000Z',
    processing_status:'PROCESSING',
    outcome_code:null,
    payment_id:null,
    payload_digest_sha256:DIGEST,
    failure_code:null,
    received_at:'2026-09-07T03:00:01.000Z',
    processed_at:null,
    created_at:'2026-09-07T03:00:01.000Z',
    updated_at:'2026-09-07T03:00:01.000Z',
    ...overrides
  };
}

test('PostgresPaymentCallbackStore requires a pg-compatible queryable', () => {
  assert.throws(() => new PostgresPaymentCallbackStore(), /queryable|query/i);
  assert.throws(() => new PostgresPaymentCallbackStore({}), /queryable|query/i);
});

test('claim atomically inserts a new callback identity with parameterized canonical evidence', async () => {
  const db = new FakeQueryable([{ rows:[callbackRow()] }]);
  const store = new PostgresPaymentCallbackStore(db);

  const result = await store.claim(callbackInput(), {
    payloadDigestSha256:DIGEST,
    receivedAt:'2026-09-07T03:00:01.000Z'
  });

  assert.equal(result.kind, 'NEW');
  assert.equal(Object.isFrozen(result.callback), true);
  assert.equal(result.callback.callbackId, CALLBACK_ID);
  assert.equal(result.callback.amountMinor, 12500);
  assert.equal(result.callback.processingStatus, 'PROCESSING');
  assert.match(db.calls[0].text, /INSERT INTO finance\.payment_gateway_callbacks/i);
  assert.match(db.calls[0].text, /ON CONFLICT\s*\(\s*provider\s*,\s*provider_event_id\s*\)\s*DO NOTHING/i);
  assert.match(db.calls[0].text, /PROCESSING/i);
  assert.equal(db.calls[0].params.includes(DIGEST), true);
  assert.equal(db.calls[0].params.includes('gw-1'), true);
  assert.doesNotMatch(db.calls[0].text, /raw_payload|raw_body|signature_value|authorization_header/i);
});

test('claim returns an exact existing callback as replay and locks the canonical row', async () => {
  const existing = callbackRow({
    processing_status:'APPLIED',
    outcome_code:'PAYMENT_CONFIRMED',
    payment_id:PAYMENT_ID,
    processed_at:'2026-09-07T03:00:02.000Z'
  });
  const db = new FakeQueryable([{ rows:[] }, { rows:[existing] }]);
  const store = new PostgresPaymentCallbackStore(db);

  const result = await store.claim(callbackInput(), {
    payloadDigestSha256:DIGEST,
    receivedAt:'2026-09-07T03:00:03.000Z'
  });

  assert.equal(result.kind, 'REPLAY');
  assert.equal(result.callback.processingStatus, 'APPLIED');
  assert.equal(result.callback.paymentId, PAYMENT_ID);
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[1].text, /SELECT[\s\S]+FROM finance\.payment_gateway_callbacks/i);
  assert.match(db.calls[1].text, /FOR UPDATE/i);
  assert.deepEqual(db.calls[1].params, ['BANK', 'evt-1']);
});

test('claim rejects conflicting reuse of a provider event identity', async () => {
  const stored = callbackRow({ currency:'USD' });
  const db = new FakeQueryable([{ rows:[] }, { rows:[stored] }]);
  const store = new PostgresPaymentCallbackStore(db);

  await assert.rejects(
    () => store.claim(callbackInput(), {
      payloadDigestSha256:DIGEST,
      receivedAt:'2026-09-07T03:00:03.000Z'
    }),
    error => error && error.code === 'PAYMENT_CALLBACK_EVIDENCE_CONFLICT'
  );
});

test('claim treats a payload digest mismatch as conflicting event evidence', async () => {
  const stored = callbackRow({ payload_digest_sha256:'b'.repeat(64) });
  const db = new FakeQueryable([{ rows:[] }, { rows:[stored] }]);
  const store = new PostgresPaymentCallbackStore(db);

  await assert.rejects(
    () => store.claim(callbackInput(), {
      payloadDigestSha256:DIGEST,
      receivedAt:'2026-09-07T03:00:03.000Z'
    }),
    error => error && error.code === 'PAYMENT_CALLBACK_EVIDENCE_CONFLICT'
  );
});

test('claim validates SHA-256 digest before touching the database', async () => {
  const db = new FakeQueryable();
  const store = new PostgresPaymentCallbackStore(db);

  await assert.rejects(
    () => store.claim(callbackInput(), {
      payloadDigestSha256:'bad',
      receivedAt:'2026-09-07T03:00:01.000Z'
    }),
    /sha-256|digest/i
  );
  assert.equal(db.calls.length, 0);
});

test('markApplied conditionally completes only a PROCESSING callback', async () => {
  const applied = callbackRow({
    processing_status:'APPLIED',
    outcome_code:'PAYMENT_CONFIRMED',
    payment_id:PAYMENT_ID,
    processed_at:'2026-09-07T03:00:02.000Z'
  });
  const db = new FakeQueryable([{ rows:[applied] }, { rows:[] }]);
  const store = new PostgresPaymentCallbackStore(db);

  const record = await store.markApplied({
    callbackId:CALLBACK_ID,
    paymentId:PAYMENT_ID,
    outcomeCode:'PAYMENT_CONFIRMED',
    processedAt:'2026-09-07T03:00:02.000Z'
  });

  assert.equal(record.processingStatus, 'APPLIED');
  assert.equal(record.paymentId, PAYMENT_ID);
  assert.match(db.calls[0].text, /SET\s+processing_status='APPLIED'/i);
  assert.match(db.calls[0].text, /WHERE\s+callback_id=\$1\s+AND\s+processing_status='PROCESSING'/i);
  assert.equal(db.calls[0].params.includes('PAYMENT_CONFIRMED'), true);

  await assert.rejects(
    () => store.markApplied({
      callbackId:CALLBACK_ID,
      paymentId:PAYMENT_ID,
      outcomeCode:'PAYMENT_CONFIRMED',
      processedAt:'2026-09-07T03:00:03.000Z'
    }),
    error => error && error.code === 'PAYMENT_CALLBACK_STATE_CONFLICT'
  );
});

test('markIgnored and markRejected are state-conditional and persist only normalized outcome codes', async () => {
  const ignored = callbackRow({
    event_type:'PAYMENT_FAILED',
    processing_status:'IGNORED',
    outcome_code:'GATEWAY_PAYMENT_FAILED',
    processed_at:'2026-09-07T03:00:02.000Z'
  });
  const rejected = callbackRow({
    processing_status:'REJECTED',
    failure_code:'PAYMENT_EVIDENCE_MISMATCH',
    processed_at:'2026-09-07T03:00:03.000Z'
  });
  const db = new FakeQueryable([{ rows:[ignored] }, { rows:[rejected] }]);
  const store = new PostgresPaymentCallbackStore(db);

  const ignoredRecord = await store.markIgnored({
    callbackId:CALLBACK_ID,
    outcomeCode:'GATEWAY_PAYMENT_FAILED',
    processedAt:'2026-09-07T03:00:02.000Z'
  });
  assert.equal(ignoredRecord.processingStatus, 'IGNORED');
  assert.match(db.calls[0].text, /processing_status='IGNORED'/i);
  assert.match(db.calls[0].text, /processing_status='PROCESSING'/i);

  const rejectedRecord = await store.markRejected({
    callbackId:CALLBACK_ID,
    failureCode:'PAYMENT_EVIDENCE_MISMATCH',
    processedAt:'2026-09-07T03:00:03.000Z'
  });
  assert.equal(rejectedRecord.processingStatus, 'REJECTED');
  assert.equal(rejectedRecord.failureCode, 'PAYMENT_EVIDENCE_MISMATCH');
  assert.match(db.calls[1].text, /processing_status='REJECTED'/i);
  assert.match(db.calls[1].text, /processing_status='PROCESSING'/i);
});

test('store API exposes no raw callback persistence or deletion operation', () => {
  const store = new PostgresPaymentCallbackStore(new FakeQueryable());
  assert.equal(typeof store.saveRawPayload, 'undefined');
  assert.equal(typeof store.delete, 'undefined');
  assert.equal(typeof store.hardDelete, 'undefined');
});
