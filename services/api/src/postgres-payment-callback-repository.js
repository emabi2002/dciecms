'use strict';

const PAYMENT_COLUMNS = `payment_id,assessment_id,court_id,amount_minor,currency,status,provider_code,
  provider_reference,created_by_subject,created_at,confirmed_by_subject,confirmed_at`;

const CALLBACK_COLUMNS = `callback_event_id,provider_code,provider_event_id,payment_id,body_sha256,
  provider_reference,event_status,amount_minor,currency,occurred_at,received_at,processed_at,processing_status`;

function mapPayment(row) {
  if (!row) return null;
  return Object.freeze({
    paymentId: row.payment_id,
    assessmentId: row.assessment_id,
    courtId: row.court_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    providerCode: row.provider_code || null,
    providerReference: row.provider_reference || null,
    createdBy: row.created_by_subject,
    createdAt: row.created_at,
    confirmedBy: row.confirmed_by_subject || null,
    confirmedAt: row.confirmed_at || null
  });
}

function mapPaymentCallback(row) {
  if (!row) return null;
  return Object.freeze({
    callbackEventId: row.callback_event_id,
    providerCode: row.provider_code,
    providerEventId: row.provider_event_id,
    paymentId: row.payment_id,
    bodySha256: row.body_sha256,
    providerReference: row.provider_reference,
    eventStatus: row.event_status,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    processedAt: row.processed_at || null,
    processingStatus: row.processing_status
  });
}

function callbackStateConflict(message) {
  const error = new Error(message);
  error.code = 'PAYMENT_CALLBACK_STATE_CONFLICT';
  return error;
}

function installPaymentCallbackRepository(PostgresRepository) {
  if (!PostgresRepository || !PostgresRepository.prototype) {
    throw new TypeError('PostgresRepository constructor is required');
  }

  PostgresRepository.prototype.createPayment = async function createPayment({
    paymentId,
    assessmentId,
    courtId,
    amountMinor,
    currency,
    providerCode = null,
    actorSubject,
    at
  }) {
    const result = await this.db.query(
      `INSERT INTO finance.payments (payment_id,assessment_id,court_id,amount_minor,currency,status,provider_code,created_by_subject,created_at)
       VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8)
       RETURNING ${PAYMENT_COLUMNS}`,
      [paymentId, assessmentId, courtId, amountMinor, currency, providerCode || null, actorSubject, at]
    );
    return mapPayment(result.rows[0]);
  };

  PostgresRepository.prototype.getPayment = async function getPayment(paymentId) {
    const result = await this.db.query(
      `SELECT ${PAYMENT_COLUMNS} FROM finance.payments WHERE payment_id=$1`,
      [paymentId]
    );
    return mapPayment(result.rows[0]);
  };

  PostgresRepository.prototype.confirmPayment = async function confirmPayment({
    paymentId,
    providerReference,
    actorSubject,
    at
  }) {
    const result = await this.db.query(
      `UPDATE finance.payments
       SET status='CONFIRMED',provider_reference=$2,confirmed_by_subject=$3,confirmed_at=$4
       WHERE payment_id=$1 AND status='PENDING'
       RETURNING ${PAYMENT_COLUMNS}`,
      [paymentId, providerReference, actorSubject, at]
    );
    if (result.rows.length !== 1) {
      const error = new Error('Payment was not PENDING');
      error.code = 'PAYMENT_STATE_CONFLICT';
      throw error;
    }
    return mapPayment(result.rows[0]);
  };

  PostgresRepository.prototype.claimPaymentCallback = async function claimPaymentCallback({
    callbackEventId,
    providerCode,
    providerEventId,
    paymentId,
    bodySha256,
    providerReference,
    eventStatus,
    amountMinor,
    currency,
    occurredAt,
    receivedAt
  }) {
    const inserted = await this.db.query(
      `INSERT INTO integration.payment_callback_events (
         callback_event_id,provider_code,provider_event_id,payment_id,body_sha256,provider_reference,
         event_status,amount_minor,currency,occurred_at,received_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (provider_code, provider_event_id) DO NOTHING
       RETURNING ${CALLBACK_COLUMNS}`,
      [
        callbackEventId,
        providerCode,
        providerEventId,
        paymentId,
        bodySha256,
        providerReference,
        eventStatus,
        amountMinor,
        currency,
        occurredAt,
        receivedAt
      ]
    );

    if (inserted.rows.length === 1) {
      return Object.freeze({ claimed: true, event: mapPaymentCallback(inserted.rows[0]) });
    }

    const existing = await this.db.query(
      `SELECT ${CALLBACK_COLUMNS}
       FROM integration.payment_callback_events
       WHERE provider_code=$1 AND provider_event_id=$2`,
      [providerCode, providerEventId]
    );
    if (existing.rows.length !== 1) {
      throw callbackStateConflict('Payment callback canonical replay evidence is unavailable');
    }
    return Object.freeze({ claimed: false, event: mapPaymentCallback(existing.rows[0]) });
  };

  PostgresRepository.prototype.markPaymentCallbackProcessed = async function markPaymentCallbackProcessed({
    callbackEventId,
    processedAt
  }) {
    const result = await this.db.query(
      `UPDATE integration.payment_callback_events
       SET processing_status='PROCESSED',processed_at=$2
       WHERE callback_event_id=$1 AND processing_status='RECEIVED'
       RETURNING ${CALLBACK_COLUMNS}`,
      [callbackEventId, processedAt]
    );
    if (result.rows.length !== 1) {
      throw callbackStateConflict('Payment callback was not in RECEIVED state');
    }
    return mapPaymentCallback(result.rows[0]);
  };
}

module.exports = {
  PAYMENT_COLUMNS,
  CALLBACK_COLUMNS,
  mapPayment,
  mapPaymentCallback,
  installPaymentCallbackRepository
};
