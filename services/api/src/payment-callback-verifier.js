'use strict';

class PaymentCallbackAuthenticationError extends Error {
  constructor(message = 'Payment callback authentication failed') {
    super(message);
    this.name = 'PaymentCallbackAuthenticationError';
  }
}

class PaymentCallbackUnavailableError extends Error {
  constructor(message = 'Payment callback verifier unavailable') {
    super(message);
    this.name = 'PaymentCallbackUnavailableError';
  }
}

class PaymentCallbackValidationError extends Error {
  constructor(message = 'Invalid payment callback evidence') {
    super(message);
    this.name = 'PaymentCallbackValidationError';
  }
}

const PROVIDER_CODE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function requireBoundedText(value, field, maxLength) {
  const normalized = String(value == null ? '' : value).trim();
  if (!normalized || normalized.length > maxLength) {
    throw new PaymentCallbackValidationError(`${field} is invalid`);
  }
  return normalized;
}

function requireIsoTimestamp(value, field) {
  const normalized = requireBoundedText(value, field, 64);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    throw new PaymentCallbackValidationError(`${field} is invalid`);
  }
  return normalized;
}

function normalizeProviderCode(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (!PROVIDER_CODE_RE.test(normalized)) {
    throw new PaymentCallbackValidationError('providerCode is invalid');
  }
  return normalized;
}

function normalizeVerifiedPaymentCallback(value, { receivedAt, bodySha256 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PaymentCallbackValidationError('Verified callback must be an object');
  }

  const providerCode = normalizeProviderCode(value.providerCode);
  const providerEventId = requireBoundedText(value.providerEventId, 'providerEventId', 180);
  const paymentId = requireBoundedText(value.paymentId, 'paymentId', 64);
  if (!UUID_RE.test(paymentId)) throw new PaymentCallbackValidationError('paymentId is invalid');

  const providerReference = requireBoundedText(value.providerReference, 'providerReference', 160);
  if (value.status !== 'CONFIRMED') throw new PaymentCallbackValidationError('status must be CONFIRMED');
  if (!Number.isSafeInteger(value.amountMinor) || value.amountMinor <= 0) {
    throw new PaymentCallbackValidationError('amountMinor must be a positive safe integer');
  }

  const currency = requireBoundedText(value.currency, 'currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new PaymentCallbackValidationError('currency is invalid');

  const normalizedOccurredAt = requireIsoTimestamp(value.occurredAt, 'occurredAt');
  const normalizedReceivedAt = requireIsoTimestamp(receivedAt, 'receivedAt');
  const normalizedBodySha256 = String(bodySha256 == null ? '' : bodySha256).trim().toLowerCase();
  if (!SHA256_RE.test(normalizedBodySha256)) {
    throw new PaymentCallbackValidationError('bodySha256 is invalid');
  }

  return Object.freeze({
    providerCode,
    providerEventId,
    paymentId,
    providerReference,
    status: 'CONFIRMED',
    amountMinor: value.amountMinor,
    currency,
    occurredAt: normalizedOccurredAt,
    receivedAt: normalizedReceivedAt,
    bodySha256: normalizedBodySha256
  });
}

function assertPaymentCallbackVerifier(verifier) {
  if (!verifier || typeof verifier.verify !== 'function') {
    throw new TypeError('Payment callback verifier must expose verify()');
  }
  return verifier;
}

class ScriptedPaymentCallbackVerifier {
  constructor(script = []) {
    if (!Array.isArray(script)) throw new TypeError('Scripted verifier requires an array');
    this.script = script.slice();
    this.developmentOnly = true;
  }

  async verify() {
    if (this.script.length === 0) {
      throw new PaymentCallbackUnavailableError('No scripted callback result is available');
    }
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

module.exports = {
  PaymentCallbackAuthenticationError,
  PaymentCallbackUnavailableError,
  PaymentCallbackValidationError,
  normalizeProviderCode,
  normalizeVerifiedPaymentCallback,
  assertPaymentCallbackVerifier,
  ScriptedPaymentCallbackVerifier
};
