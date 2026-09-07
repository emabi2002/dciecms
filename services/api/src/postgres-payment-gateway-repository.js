'use strict';

const PAYMENT_COLUMNS = `payment_id, assessment_id, court_id, amount_minor, currency,
  status, provider_reference, created_by_subject, created_at,
  confirmed_by_subject, confirmed_at`;

function gatewayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, fieldName, maxLength) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${fieldName} is required`);
  if (normalized.length > maxLength) throw new TypeError(`${fieldName} exceeds the allowed length`);
  return normalized;
}

function normalizeCurrency(value) {
  const currency = requiredString(value, 'currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('currency must be a 3-letter code');
  return currency;
}

function normalizeTimestamp(value, fieldName) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw new TypeError(`${fieldName} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

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
    createdBy: row.created_by_subject,
    createdAt: row.created_at,
    confirmedBy: row.confirmed_by_subject || null,
    confirmedAt: row.confirmed_at || null
  });
}

function installPaymentGatewayRepository(PostgresRepository) {
  if (!PostgresRepository || !PostgresRepository.prototype) {
    throw new TypeError('PostgresRepository constructor is required');
  }

  if (typeof PostgresRepository.prototype.confirmPaymentFromVerifiedGateway === 'function') {
    return PostgresRepository;
  }

  PostgresRepository.prototype.confirmPaymentFromVerifiedGateway = async function confirmPaymentFromVerifiedGateway({
    paymentReference,
    providerPaymentReference,
    amountMinor,
    currency,
    actorSubject = 'system:payment-gateway',
    confirmedAt = new Date().toISOString()
  } = {}) {
    const paymentId = requiredString(paymentReference, 'paymentReference', 120);
    const providerReference = requiredString(providerPaymentReference, 'providerPaymentReference', 180);
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new TypeError('amountMinor must be a non-negative safe integer');
    }
    const normalizedCurrency = normalizeCurrency(currency);
    const subject = requiredString(actorSubject, 'actorSubject', 255);
    const confirmed = normalizeTimestamp(confirmedAt, 'confirmedAt');

    const currentResult = await this.db.query(`SELECT ${PAYMENT_COLUMNS}
      FROM finance.payments
      WHERE payment_id=$1
      FOR UPDATE`, [paymentId]);

    if (currentResult.rows.length !== 1) {
      throw gatewayError('PAYMENT_NOT_FOUND', 'Payment reference was not found');
    }

    const current = mapPayment(currentResult.rows[0]);
    if (current.amountMinor !== amountMinor) {
      throw gatewayError('PAYMENT_GATEWAY_AMOUNT_MISMATCH', 'Gateway amount does not match the authoritative payment');
    }
    if (String(current.currency || '').toUpperCase() !== normalizedCurrency) {
      throw gatewayError('PAYMENT_GATEWAY_CURRENCY_MISMATCH', 'Gateway currency does not match the authoritative payment');
    }
    if (current.providerReference && current.providerReference !== providerReference) {
      throw gatewayError('PAYMENT_GATEWAY_REFERENCE_MISMATCH', 'Gateway reference conflicts with the authoritative payment');
    }
    if (current.status !== 'PENDING') {
      throw gatewayError('PAYMENT_GATEWAY_STATE_CONFLICT', 'Payment is not pending confirmation');
    }

    const updated = await this.db.query(`UPDATE finance.payments
      SET status='CONFIRMED', provider_reference=$2,
          confirmed_by_subject=$3, confirmed_at=$4::timestamptz
      WHERE payment_id=$1 AND status='PENDING'
      RETURNING ${PAYMENT_COLUMNS}`,
    [paymentId, providerReference, subject, confirmed]);

    if (updated.rows.length !== 1) {
      throw gatewayError('PAYMENT_GATEWAY_STATE_CONFLICT', 'Payment is not pending confirmation');
    }

    return mapPayment(updated.rows[0]);
  };

  return PostgresRepository;
}

module.exports = {
  installPaymentGatewayRepository,
  mapPayment
};
