'use strict';

const { assertPaymentProvider } = require('./payment-provider');

const EVENT_TYPES = new Set([
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'PAYMENT_CANCELLED',
  'PAYMENT_REFUNDED',
  'PAYMENT_REVERSED'
]);
const SETTLEMENT_EVIDENCE_EVENTS = new Set([
  'PAYMENT_SUCCEEDED',
  'PAYMENT_REFUNDED',
  'PAYMENT_REVERSED'
]);

class PaymentWebhookValidationError extends Error {
  constructor(message = 'Invalid normalized payment provider event') {
    super(message);
    this.name = 'PaymentWebhookValidationError';
    this.statusCode = 422;
  }
}

class PaymentWebhookVerificationError extends Error {
  constructor(message = 'Payment webhook verification failed') {
    super(message);
    this.name = 'PaymentWebhookVerificationError';
    this.statusCode = 401;
  }
}

class PaymentWebhookBodyTooLargeError extends Error {
  constructor(message = 'Payment webhook body exceeds configured size limit') {
    super(message);
    this.name = 'PaymentWebhookBodyTooLargeError';
    this.statusCode = 413;
  }
}

function requireMethod(target, methodName, label) {
  if (!target || typeof target[methodName] !== 'function') {
    throw new TypeError(`${label} must expose ${methodName}()`);
  }
}

function normalizeClock(clock) {
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.now === 'function') return () => clock.now();
  return () => new Date();
}

function providerCode(value) {
  return String(value || '').trim().toLowerCase();
}

function requiredText(value, label, maxLength = 255) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new PaymentWebhookValidationError(`${label} is required in normalized provider event`);
  if (normalized.length > maxLength) throw new PaymentWebhookValidationError(`${label} exceeds normalized provider event limit`);
  return normalized;
}

function validIso(value, label) {
  const text = requiredText(value, label, 80);
  if (Number.isNaN(Date.parse(text))) throw new PaymentWebhookValidationError(`${label} must be a valid provider timestamp`);
  return new Date(text).toISOString();
}

function normalizeAmountCurrency(eventType, event) {
  const hasAmount = event.amountMinor !== undefined && event.amountMinor !== null;
  const hasCurrency = event.currency !== undefined && event.currency !== null && String(event.currency).trim() !== '';

  if (SETTLEMENT_EVIDENCE_EVENTS.has(eventType) && (!hasAmount || !hasCurrency)) {
    throw new PaymentWebhookValidationError('Settlement event requires normalized amount and currency evidence');
  }
  if (hasAmount !== hasCurrency) {
    throw new PaymentWebhookValidationError('Normalized amount and currency evidence must be supplied together');
  }
  if (!hasAmount) return Object.freeze({ amountMinor: null, currency: null });

  const amountMinor = Number(event.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new PaymentWebhookValidationError('Normalized amount must be a positive integer');
  }
  const currency = String(event.currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PaymentWebhookValidationError('Normalized currency must be a 3-letter code');
  }
  return Object.freeze({ amountMinor, currency });
}

class PaymentWebhookService {
  constructor({
    repository,
    provider,
    providerCode: configuredProviderCode = null,
    maxBodyBytes = 256 * 1024,
    clock = () => new Date()
  } = {}) {
    requireMethod(repository, 'recordPaymentProviderEvent', 'repository');
    const asserted = assertPaymentProvider(provider);
    const capabilityCode = asserted.capabilities.providerCode;
    const configured = providerCode(configuredProviderCode || capabilityCode);
    if (!configured || configured !== capabilityCode) {
      throw new TypeError('Configured payment provider code must match provider capabilities');
    }
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1024 * 1024) {
      throw new TypeError('maxBodyBytes must be an integer between 1 and 1048576');
    }

    this.repository = repository;
    this.provider = asserted.provider;
    this.providerCode = configured;
    this.maxBodyBytes = maxBodyBytes;
    this.clock = normalizeClock(clock);
  }

  _nowIso() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('clock returned an invalid timestamp');
    return date.toISOString();
  }

  _normalizeVerifiedEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new PaymentWebhookValidationError('Provider verification did not return a normalized event');
    }

    const verifiedProviderCode = providerCode(event.providerCode);
    if (!verifiedProviderCode || verifiedProviderCode !== this.providerCode) {
      throw new PaymentWebhookValidationError('Normalized provider event does not match configured provider');
    }

    const providerEventId = requiredText(event.providerEventId, 'provider event id');
    const providerPaymentReference = requiredText(event.providerPaymentReference, 'provider payment reference');
    const paymentId = requiredText(event.paymentId, 'payment correlation id');
    const normalizedEventType = String(event.eventType || event.normalizedEventType || '').trim().toUpperCase();
    if (!EVENT_TYPES.has(normalizedEventType)) {
      throw new PaymentWebhookValidationError('Unknown normalized payment provider event type');
    }
    const { amountMinor, currency } = normalizeAmountCurrency(normalizedEventType, event);
    const authenticatedAt = validIso(event.authenticatedAt, 'authenticatedAt');

    return Object.freeze({
      providerCode: this.providerCode,
      providerEventId,
      providerPaymentReference,
      paymentId,
      normalizedEventType,
      amountMinor,
      currency,
      authenticatedAt
    });
  }

  async ingest({ rawBody, headers = {} } = {}) {
    if (!Buffer.isBuffer(rawBody)) {
      throw new PaymentWebhookValidationError('Payment webhook raw body must be provided as bytes');
    }
    if (rawBody.length > this.maxBodyBytes) {
      throw new PaymentWebhookBodyTooLargeError();
    }

    let verified;
    try {
      verified = await this.provider.verifyWebhook({ rawBody, headers });
    } catch {
      throw new PaymentWebhookVerificationError();
    }

    const normalized = this._normalizeVerifiedEvent(verified);
    return this.repository.recordPaymentProviderEvent({
      ...normalized,
      receivedAt: this._nowIso()
    });
  }
}

module.exports = {
  EVENT_TYPES,
  PaymentWebhookService,
  PaymentWebhookValidationError,
  PaymentWebhookVerificationError,
  PaymentWebhookBodyTooLargeError
};
