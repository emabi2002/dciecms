'use strict';

const PAYMENT_COLUMNS = `payment_id,assessment_id,court_id,amount_minor,currency,status,provider_reference,
  provider_code,provider_payment_reference,provider_status,session_created_at,provider_confirmed_at,
  failure_code,cancelled_at,refunded_at,reversed_at,created_by_subject,created_at,
  confirmed_by_subject,confirmed_at`;

const PROVIDER_EVENT_COLUMNS = `payment_provider_event_record_id,provider_code,provider_event_id,
  provider_payment_reference,payment_id,normalized_event_type,amount_minor,currency,
  processing_status,attempt_count,max_attempts,next_attempt_at,lease_owner,lease_expires_at,
  result_code,received_at,authenticated_at,processed_at,created_at,updated_at`;

function mapPayment(row) {
  if (!row) return null;
  return Object.freeze({
    paymentId: row.payment_id,
    assessmentId: row.assessment_id,
    courtId: row.court_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    providerReference: row.provider_reference || null,
    providerCode: row.provider_code || null,
    providerPaymentReference: row.provider_payment_reference || null,
    providerStatus: row.provider_status || null,
    sessionCreatedAt: row.session_created_at || null,
    providerConfirmedAt: row.provider_confirmed_at || null,
    failureCode: row.failure_code || null,
    cancelledAt: row.cancelled_at || null,
    refundedAt: row.refunded_at || null,
    reversedAt: row.reversed_at || null,
    createdBy: row.created_by_subject || null,
    createdAt: row.created_at || null,
    confirmedBy: row.confirmed_by_subject || null,
    confirmedAt: row.confirmed_at || null
  });
}

function mapProviderEvent(row) {
  if (!row) return null;
  return Object.freeze({
    eventRecordId: row.payment_provider_event_record_id,
    providerCode: row.provider_code,
    providerEventId: row.provider_event_id,
    providerPaymentReference: row.provider_payment_reference,
    paymentId: row.payment_id || null,
    normalizedEventType: row.normalized_event_type,
    amountMinor: row.amount_minor == null ? null : Number(row.amount_minor),
    currency: row.currency || null,
    processingStatus: row.processing_status,
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 0),
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at || null,
    resultCode: row.result_code || null,
    receivedAt: row.received_at,
    authenticatedAt: row.authenticated_at,
    processedAt: row.processed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireResultCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,80}$/.test(code)) {
    throw new TypeError('Payment provider event result code must be a sanitized stable code');
  }
  return code;
}

function installPaymentIntegrationRepository(PostgresRepository) {
  if (!PostgresRepository?.prototype) throw new TypeError('PostgresRepository constructor is required');
  const proto = PostgresRepository.prototype;
  if (proto.__paymentIntegrationRepositoryInstalled) return;

  Object.defineProperty(proto, '__paymentIntegrationRepositoryInstalled', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  proto.bindPaymentProviderSession = async function bindPaymentProviderSession({
    paymentId,
    providerCode,
    providerPaymentReference,
    providerStatus = 'SESSION_CREATED',
    sessionCreatedAt
  }) {
    const result = await this.db.query(`UPDATE finance.payments
      SET provider_code=$2,
          provider_payment_reference=$3,
          provider_status=$4,
          session_created_at=$5
      WHERE payment_id=$1
        AND status='PENDING'
        AND provider_code IS NULL
        AND provider_payment_reference IS NULL
      RETURNING ${PAYMENT_COLUMNS}`, [
      paymentId,
      providerCode,
      providerPaymentReference,
      providerStatus,
      sessionCreatedAt
    ]);
    if (result.rows.length !== 1) {
      throw conflict('PAYMENT_PROVIDER_BINDING_CONFLICT', 'Payment is not eligible for provider binding');
    }
    return mapPayment(result.rows[0]);
  };

  proto.getPaymentProviderBinding = async function getPaymentProviderBinding(paymentId) {
    const result = await this.db.query(`SELECT ${PAYMENT_COLUMNS}
      FROM finance.payments
      WHERE payment_id=$1`, [paymentId]);
    return mapPayment(result.rows[0]);
  };

  proto.getPaymentProviderEvent = async function getPaymentProviderEvent(eventRecordId) {
    const result = await this.db.query(`SELECT ${PROVIDER_EVENT_COLUMNS}
      FROM finance.payment_provider_events
      WHERE payment_provider_event_record_id=$1`, [eventRecordId]);
    return mapProviderEvent(result.rows[0]);
  };

  proto.recordPaymentProviderEvent = async function recordPaymentProviderEvent({
    providerCode,
    providerEventId,
    providerPaymentReference,
    paymentId,
    normalizedEventType,
    amountMinor = null,
    currency = null,
    authenticatedAt,
    receivedAt = authenticatedAt,
    maxAttempts = 5
  }) {
    const inserted = await this.db.query(`INSERT INTO finance.payment_provider_events (
      provider_code,provider_event_id,provider_payment_reference,payment_id,
      normalized_event_type,amount_minor,currency,authenticated_at,received_at,
      max_attempts,next_attempt_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9)
    ON CONFLICT (provider_code,provider_event_id) DO NOTHING
    RETURNING ${PROVIDER_EVENT_COLUMNS}`, [
      providerCode,
      providerEventId,
      providerPaymentReference,
      paymentId || null,
      normalizedEventType,
      amountMinor == null ? null : Number(amountMinor),
      currency || null,
      authenticatedAt,
      receivedAt,
      maxAttempts
    ]);
    if (inserted.rows.length === 1) return mapProviderEvent(inserted.rows[0]);

    const existing = await this.db.query(`SELECT ${PROVIDER_EVENT_COLUMNS}
      FROM finance.payment_provider_events
      WHERE provider_code=$1 AND provider_event_id=$2`, [providerCode, providerEventId]);
    if (existing.rows.length !== 1) {
      throw conflict('PAYMENT_PROVIDER_EVENT_REPLAY_CONFLICT', 'Canonical provider event is unavailable');
    }
    return mapProviderEvent(existing.rows[0]);
  };

  proto.confirmPaymentFromProviderEvidence = async function confirmPaymentFromProviderEvidence({
    paymentId,
    providerCode,
    providerPaymentReference,
    amountMinor,
    currency,
    confirmedAt,
    actorSubject = 'system:payment-provider'
  }) {
    const result = await this.db.query(`UPDATE finance.payments
      SET status='CONFIRMED',
          provider_status='SUCCEEDED',
          provider_confirmed_at=$6,
          confirmed_by_subject=$7,
          confirmed_at=$6
      WHERE payment_id=$1
        AND status='PENDING'
        AND provider_code=$2
        AND provider_payment_reference=$3
        AND amount_minor=$4
        AND currency=$5
      RETURNING ${PAYMENT_COLUMNS}`, [
      paymentId,
      providerCode,
      providerPaymentReference,
      Number(amountMinor),
      currency,
      confirmedAt,
      actorSubject
    ]);
    if (result.rows.length !== 1) {
      throw conflict('PAYMENT_PROVIDER_EVIDENCE_CONFLICT', 'Provider payment evidence does not match the canonical payment');
    }
    return mapPayment(result.rows[0]);
  };

  proto.transitionPaymentProviderOutcome = async function transitionPaymentProviderOutcome({
    paymentId,
    providerCode,
    providerPaymentReference,
    normalizedEventType,
    at,
    resultCode
  }) {
    const type = String(normalizedEventType || '').trim().toUpperCase();
    const code = requireResultCode(resultCode || type);
    let sql;
    let params;

    if (type === 'PAYMENT_FAILED') {
      sql = `UPDATE finance.payments
        SET status='FAILED', provider_status='FAILED', failure_code=$5
        WHERE payment_id=$1
          AND provider_code=$2
          AND provider_payment_reference=$3
          AND status='PENDING'
        RETURNING ${PAYMENT_COLUMNS}`;
      params = [paymentId, providerCode, providerPaymentReference, at, code];
    } else if (type === 'PAYMENT_CANCELLED') {
      sql = `UPDATE finance.payments
        SET status='CANCELLED', provider_status='CANCELLED', cancelled_at=$4
        WHERE payment_id=$1
          AND provider_code=$2
          AND provider_payment_reference=$3
          AND status='PENDING'
        RETURNING ${PAYMENT_COLUMNS}`;
      params = [paymentId, providerCode, providerPaymentReference, at];
    } else if (type === 'PAYMENT_REFUNDED') {
      sql = `UPDATE finance.payments
        SET status='REFUNDED', provider_status='REFUNDED', refunded_at=$4
        WHERE payment_id=$1
          AND provider_code=$2
          AND provider_payment_reference=$3
          AND status='CONFIRMED'
        RETURNING ${PAYMENT_COLUMNS}`;
      params = [paymentId, providerCode, providerPaymentReference, at];
    } else if (type === 'PAYMENT_REVERSED') {
      sql = `UPDATE finance.payments
        SET status='REFUNDED', provider_status='REVERSED', reversed_at=$4
        WHERE payment_id=$1
          AND provider_code=$2
          AND provider_payment_reference=$3
          AND status='CONFIRMED'
        RETURNING ${PAYMENT_COLUMNS}`;
      params = [paymentId, providerCode, providerPaymentReference, at];
    } else {
      throw new TypeError('Unsupported canonical payment provider outcome');
    }

    const result = await this.db.query(sql, params);
    if (result.rows.length !== 1) {
      throw conflict('PAYMENT_PROVIDER_OUTCOME_CONFLICT', 'Payment is not eligible for the verified provider outcome');
    }
    return mapPayment(result.rows[0]);
  };

  async function finalizeProviderEvent(repository, processingStatus, {
    eventRecordId,
    resultCode,
    processedAt
  }) {
    const code = requireResultCode(resultCode);
    const result = await repository.db.query(`UPDATE finance.payment_provider_events
      SET processing_status='${processingStatus}',
          result_code=$2,
          processed_at=$3,
          updated_at=$3,
          lease_owner=NULL,
          lease_expires_at=NULL
      WHERE payment_provider_event_record_id=$1
        AND processing_status IN ('RECEIVED','PROCESSING')
      RETURNING ${PROVIDER_EVENT_COLUMNS}`, [eventRecordId, code, processedAt]);
    if (result.rows.length !== 1) {
      throw conflict('PAYMENT_PROVIDER_EVENT_STATE_CONFLICT', 'Provider event is no longer eligible for processing');
    }
    return mapProviderEvent(result.rows[0]);
  }

  proto.markPaymentProviderEventProcessed = async function markPaymentProviderEventProcessed(input) {
    return finalizeProviderEvent(this, 'PROCESSED', input);
  };

  proto.markPaymentProviderEventRejected = async function markPaymentProviderEventRejected(input) {
    return finalizeProviderEvent(this, 'REJECTED', input);
  };
}

module.exports = {
  PAYMENT_COLUMNS,
  PROVIDER_EVENT_COLUMNS,
  mapPayment,
  mapProviderEvent,
  installPaymentIntegrationRepository
};
