'use strict';

const {
  normalizeVerifiedPaymentCallback
} = require('./payment-gateway-verifier');

const CALLBACK_COLUMNS = `callback_id, provider, provider_event_id, event_type,
  payment_reference, provider_payment_reference, amount_minor, currency,
  occurred_at, processing_status, outcome_code, payment_id,
  payload_digest_sha256, failure_code, received_at, processed_at,
  created_at, updated_at`;

function freeze(value) {
  return Object.freeze(value);
}

function normalizedIso(value, fieldName) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw new TypeError(`${fieldName} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function requiredCode(value, fieldName, maxLength = 80) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) throw new TypeError(`${fieldName} is required`);
  if (normalized.length > maxLength) throw new TypeError(`${fieldName} exceeds the allowed length`);
  if (!/^[A-Z0-9][A-Z0-9._:-]*$/.test(normalized)) {
    throw new TypeError(`${fieldName} contains unsupported characters`);
  }
  return normalized;
}

function requiredId(value, fieldName) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${fieldName} is required`);
  return normalized;
}

function payloadDigest(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new TypeError('payloadDigestSha256 must be a SHA-256 hex digest');
  }
  return normalized;
}

function stateConflict(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mapPaymentCallbackRow(row) {
  if (!row) return null;
  return freeze({
    callbackId: row.callback_id,
    provider: row.provider,
    eventId: row.provider_event_id,
    eventType: row.event_type,
    paymentReference: row.payment_reference,
    providerPaymentReference: row.provider_payment_reference,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    occurredAt: normalizedIso(row.occurred_at, 'occurredAt'),
    processingStatus: row.processing_status,
    outcomeCode: row.outcome_code || null,
    paymentId: row.payment_id || null,
    payloadDigestSha256: row.payload_digest_sha256,
    failureCode: row.failure_code || null,
    receivedAt: normalizedIso(row.received_at, 'receivedAt'),
    processedAt: row.processed_at ? normalizedIso(row.processed_at, 'processedAt') : null,
    createdAt: normalizedIso(row.created_at, 'createdAt'),
    updatedAt: normalizedIso(row.updated_at, 'updatedAt')
  });
}

function canonicalEvidenceMatches(stored, callback, digest) {
  return stored.provider === callback.provider &&
    stored.eventId === callback.eventId &&
    stored.eventType === callback.eventType &&
    stored.paymentReference === callback.paymentReference &&
    stored.providerPaymentReference === callback.providerPaymentReference &&
    stored.amountMinor === callback.amountMinor &&
    stored.currency === callback.currency &&
    stored.occurredAt === callback.occurredAt &&
    stored.payloadDigestSha256 === digest;
}

class PostgresPaymentCallbackStore {
  constructor(queryable) {
    if (!queryable || typeof queryable.query !== 'function') {
      throw new TypeError('PostgresPaymentCallbackStore requires a pg-compatible queryable');
    }
    this.db = queryable;
  }

  async claim(input, {
    payloadDigestSha256,
    receivedAt = new Date().toISOString()
  } = {}) {
    const callback = normalizeVerifiedPaymentCallback(input);
    const digest = payloadDigest(payloadDigestSha256);
    const received = normalizedIso(receivedAt, 'receivedAt');

    const params = [
      callback.provider,
      callback.eventId,
      callback.eventType,
      callback.paymentReference,
      callback.providerPaymentReference,
      callback.amountMinor,
      callback.currency,
      callback.occurredAt,
      digest,
      received
    ];

    const inserted = await this.db.query(`INSERT INTO finance.payment_gateway_callbacks (
      provider, provider_event_id, event_type, payment_reference,
      provider_payment_reference, amount_minor, currency, occurred_at,
      processing_status, payload_digest_sha256, received_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,'PROCESSING',$9,$10::timestamptz)
    ON CONFLICT (provider, provider_event_id) DO NOTHING
    RETURNING ${CALLBACK_COLUMNS}`, params);

    if (inserted.rows.length === 1) {
      return freeze({ kind:'NEW', callback:mapPaymentCallbackRow(inserted.rows[0]) });
    }

    const existing = await this.db.query(`SELECT ${CALLBACK_COLUMNS}
      FROM finance.payment_gateway_callbacks
      WHERE provider=$1 AND provider_event_id=$2
      FOR UPDATE`, [callback.provider, callback.eventId]);

    if (existing.rows.length !== 1) {
      throw stateConflict(
        'PAYMENT_CALLBACK_IDENTITY_UNAVAILABLE',
        'Payment callback event identity is unavailable after duplicate claim'
      );
    }

    const stored = mapPaymentCallbackRow(existing.rows[0]);
    if (!canonicalEvidenceMatches(stored, callback, digest)) {
      throw stateConflict(
        'PAYMENT_CALLBACK_EVIDENCE_CONFLICT',
        'Payment callback event identity conflicts with previously received evidence'
      );
    }

    return freeze({ kind:'REPLAY', callback:stored });
  }

  async markApplied({ callbackId, paymentId, outcomeCode, processedAt = new Date().toISOString() } = {}) {
    const id = requiredId(callbackId, 'callbackId');
    const payment = requiredId(paymentId, 'paymentId');
    const outcome = requiredCode(outcomeCode, 'outcomeCode');
    const processed = normalizedIso(processedAt, 'processedAt');

    const result = await this.db.query(`UPDATE finance.payment_gateway_callbacks
      SET processing_status='APPLIED', outcome_code=$3, payment_id=$2,
          failure_code=NULL, processed_at=$4::timestamptz, updated_at=$4::timestamptz
      WHERE callback_id=$1 AND processing_status='PROCESSING'
      RETURNING ${CALLBACK_COLUMNS}`, [id, payment, outcome, processed]);

    if (result.rows.length !== 1) {
      throw stateConflict('PAYMENT_CALLBACK_STATE_CONFLICT', 'Payment callback is not in PROCESSING state');
    }
    return mapPaymentCallbackRow(result.rows[0]);
  }

  async markIgnored({ callbackId, outcomeCode, processedAt = new Date().toISOString() } = {}) {
    const id = requiredId(callbackId, 'callbackId');
    const outcome = requiredCode(outcomeCode, 'outcomeCode');
    const processed = normalizedIso(processedAt, 'processedAt');

    const result = await this.db.query(`UPDATE finance.payment_gateway_callbacks
      SET processing_status='IGNORED', outcome_code=$2, failure_code=NULL,
          processed_at=$3::timestamptz, updated_at=$3::timestamptz
      WHERE callback_id=$1 AND processing_status='PROCESSING'
      RETURNING ${CALLBACK_COLUMNS}`, [id, outcome, processed]);

    if (result.rows.length !== 1) {
      throw stateConflict('PAYMENT_CALLBACK_STATE_CONFLICT', 'Payment callback is not in PROCESSING state');
    }
    return mapPaymentCallbackRow(result.rows[0]);
  }

  async markRejected({ callbackId, failureCode, processedAt = new Date().toISOString() } = {}) {
    const id = requiredId(callbackId, 'callbackId');
    const failure = requiredCode(failureCode, 'failureCode');
    const processed = normalizedIso(processedAt, 'processedAt');

    const result = await this.db.query(`UPDATE finance.payment_gateway_callbacks
      SET processing_status='REJECTED', outcome_code=NULL, failure_code=$2,
          processed_at=$3::timestamptz, updated_at=$3::timestamptz
      WHERE callback_id=$1 AND processing_status='PROCESSING'
      RETURNING ${CALLBACK_COLUMNS}`, [id, failure, processed]);

    if (result.rows.length !== 1) {
      throw stateConflict('PAYMENT_CALLBACK_STATE_CONFLICT', 'Payment callback is not in PROCESSING state');
    }
    return mapPaymentCallbackRow(result.rows[0]);
  }
}

module.exports = {
  PostgresPaymentCallbackStore,
  mapPaymentCallbackRow
};
