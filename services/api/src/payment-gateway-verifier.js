'use strict';

const PAYMENT_EVENT_TYPES = Object.freeze(['PAYMENT_SUCCEEDED', 'PAYMENT_FAILED']);

class PaymentGatewayVerificationError extends Error {
  constructor(message = 'Payment callback verification failed', {
    statusCode = 400,
    code = 'PAYMENT_CALLBACK_INVALID'
  } = {}) {
    super(String(message || 'Payment callback verification failed'));
    this.name = 'PaymentGatewayVerificationError';
    this.statusCode = Number.isInteger(statusCode) ? statusCode : 400;
    this.code = String(code || 'PAYMENT_CALLBACK_INVALID');
  }
}

function boundedString(value, fieldName, maxLength, { uppercase = false } = {}) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new PaymentGatewayVerificationError(`${fieldName} is required`, {
      statusCode:400,
      code:'PAYMENT_CALLBACK_MALFORMED'
    });
  }
  if (normalized.length > maxLength) {
    throw new PaymentGatewayVerificationError(`${fieldName} exceeds the allowed length`, {
      statusCode:400,
      code:'PAYMENT_CALLBACK_MALFORMED'
    });
  }
  return uppercase ? normalized.toUpperCase() : normalized;
}

function normalizeVerifiedPaymentCallback(input) {
  const provider = boundedString(input?.provider, 'provider', 80, { uppercase:true });
  const eventId = boundedString(input?.eventId, 'eventId', 180);
  const eventType = boundedString(input?.eventType, 'event type', 40, { uppercase:true })
    .replace(/[\s-]+/g, '_');
  if (!PAYMENT_EVENT_TYPES.includes(eventType)) {
    throw new PaymentGatewayVerificationError('Unsupported payment callback event type', {
      statusCode:400,
      code:'PAYMENT_CALLBACK_EVENT_UNSUPPORTED'
    });
  }

  const paymentReference = boundedString(input?.paymentReference, 'paymentReference', 120);
  const providerPaymentReference = boundedString(input?.providerPaymentReference, 'providerPaymentReference', 180);

  const amountMinor = input?.amountMinor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new PaymentGatewayVerificationError('amountMinor must be a non-negative safe integer', {
      statusCode:400,
      code:'PAYMENT_CALLBACK_AMOUNT_INVALID'
    });
  }

  const currency = boundedString(input?.currency, 'currency', 3, { uppercase:true });
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PaymentGatewayVerificationError('currency must be a 3-letter uppercase code', {
      statusCode:400,
      code:'PAYMENT_CALLBACK_CURRENCY_INVALID'
    });
  }

  const occurredAtRaw = boundedString(input?.occurredAt, 'occurredAt', 80);
  const occurredAtMs = Date.parse(occurredAtRaw);
  if (!Number.isFinite(occurredAtMs)) {
    throw new PaymentGatewayVerificationError('occurredAt must be a valid timestamp', {
      statusCode:400,
      code:'PAYMENT_CALLBACK_TIMESTAMP_INVALID'
    });
  }

  return Object.freeze({
    provider,
    eventId,
    eventType,
    paymentReference,
    providerPaymentReference,
    amountMinor,
    currency,
    occurredAt: new Date(occurredAtMs).toISOString()
  });
}

function assertPaymentGatewayVerifier(verifier, { production = false } = {}) {
  if (!verifier || typeof verifier.verify !== 'function') {
    throw new TypeError('Payment gateway verifier must implement verify()');
  }
  if (typeof verifier.capabilities !== 'function') {
    throw new TypeError('Payment gateway verifier must expose capabilities()');
  }

  const capabilities = verifier.capabilities();
  if (!capabilities || typeof capabilities !== 'object') {
    throw new TypeError('Payment gateway verifier capabilities() must return an object');
  }

  if (production) {
    if (capabilities.developmentOnly === true) {
      throw new Error('Development payment gateway verifier cannot be used in production');
    }
    if (capabilities.authenticityVerified !== true) {
      throw new Error('Production payment gateway verifier must attest callback authenticity verification');
    }
    if (capabilities.replayTimeValidated !== true) {
      throw new Error('Production payment gateway verifier must attest replay-time validation');
    }
  }

  return verifier;
}

class ScriptedPaymentGatewayVerifier {
  constructor(script = []) {
    if (!Array.isArray(script)) throw new TypeError('script must be an array');
    this.script = [...script];
  }

  capabilities() {
    return Object.freeze({
      developmentOnly:true,
      authenticityVerified:true,
      replayTimeValidated:true
    });
  }

  async verify() {
    if (this.script.length === 0) {
      throw new PaymentGatewayVerificationError('No scripted payment callback result is available', {
        statusCode:503,
        code:'PAYMENT_CALLBACK_VERIFIER_UNAVAILABLE'
      });
    }
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return normalizeVerifiedPaymentCallback(next);
  }
}

module.exports = {
  PAYMENT_EVENT_TYPES,
  PaymentGatewayVerificationError,
  assertPaymentGatewayVerifier,
  normalizeVerifiedPaymentCallback,
  ScriptedPaymentGatewayVerifier
};
