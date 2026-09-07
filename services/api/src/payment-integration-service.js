'use strict';

const { authorize } = require('../../../packages/rbac');
const { assertPaymentProvider } = require('./payment-provider');

class PaymentIntegrationNotFoundError extends Error {
  constructor(message = 'Payment integration resource not found') {
    super(message);
    this.name = 'PaymentIntegrationNotFoundError';
    this.statusCode = 404;
  }
}

class PaymentIntegrationValidationError extends Error {
  constructor(message = 'Invalid payment integration request') {
    super(message);
    this.name = 'PaymentIntegrationValidationError';
    this.statusCode = 422;
  }
}

class PaymentIntegrationConflictError extends Error {
  constructor(message = 'Payment integration state conflict') {
    super(message);
    this.name = 'PaymentIntegrationConflictError';
    this.statusCode = 409;
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

function normalizeProviderCode(value) {
  return String(value || '').trim().toLowerCase();
}

function requireProviderText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new PaymentIntegrationValidationError(`Provider session ${label} is required`);
  return normalized;
}

function rejectCallerOverrides(input = {}) {
  const forbidden = [
    'amountMinor',
    'currency',
    'providerCode',
    'providerPaymentReference',
    'providerReference'
  ];
  const supplied = forbidden.find(key => Object.prototype.hasOwnProperty.call(input || {}, key));
  if (supplied) {
    throw new PaymentIntegrationValidationError(`Caller-controlled payment provider override is not accepted: ${supplied}`);
  }
}

class PaymentIntegrationService {
  constructor({ repository, provider, providerCode = null, auditStore, clock = () => new Date() } = {}) {
    requireMethod(repository, 'getPaymentProviderBinding', 'repository');
    requireMethod(repository, 'bindPaymentProviderSession', 'repository');
    requireMethod(auditStore, 'append', 'auditStore');

    const asserted = assertPaymentProvider(provider);
    const capabilityCode = asserted.capabilities.providerCode;
    const configuredCode = normalizeProviderCode(providerCode || capabilityCode);
    if (!configuredCode || configuredCode !== capabilityCode) {
      throw new TypeError('Configured payment provider code must match provider capabilities');
    }

    this.repository = repository;
    this.provider = asserted.provider;
    this.providerCode = configuredCode;
    this.auditStore = auditStore;
    this.clock = normalizeClock(clock);
  }

  _nowIso() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('clock returned an invalid timestamp');
    return date.toISOString();
  }

  async _audit(actor, payment) {
    return this.auditStore.append({
      actorUserId: actor.userId,
      effectiveRoles: [...(actor.roles || [])],
      action: 'finance.payment.session.create',
      resourceType: 'payment',
      resourceId: payment.paymentId,
      courtId: payment.courtId,
      correlationId: actor.correlationId || null,
      details: Object.freeze({ providerCode: this.providerCode })
    });
  }

  _validateProviderSession(session) {
    if (!session || typeof session !== 'object') {
      throw new PaymentIntegrationValidationError('Provider session response is invalid');
    }
    const responseProviderCode = normalizeProviderCode(session.providerCode);
    if (!responseProviderCode || responseProviderCode !== this.providerCode) {
      throw new PaymentIntegrationValidationError('Provider session provider code does not match configured provider');
    }
    const providerPaymentReference = requireProviderText(session.providerPaymentReference, 'reference');
    const checkoutUrl = requireProviderText(session.checkoutUrl, 'checkout URL');
    const expiresAt = session.expiresAt == null ? null : String(session.expiresAt).trim();
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      throw new PaymentIntegrationValidationError('Provider session expiry is invalid');
    }
    return Object.freeze({ providerPaymentReference, checkoutUrl, expiresAt: expiresAt || null });
  }

  async createPaymentSession(actor, paymentId, input = {}) {
    rejectCallerOverrides(input);

    const payment = await this.repository.getPaymentProviderBinding(paymentId);
    if (!payment) throw new PaymentIntegrationNotFoundError('Payment not found');

    authorize(actor, 'finance.payment.create', { courtId: payment.courtId });
    if (payment.status !== 'PENDING') {
      throw new PaymentIntegrationConflictError('Only an eligible pending payment may create a provider session');
    }

    const idempotencyKey = `payment-session:${payment.paymentId}`;
    const session = this._validateProviderSession(await this.provider.createPaymentSession({
      paymentId: payment.paymentId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      idempotencyKey
    }));

    let canonicalPayment = payment;
    if (payment.providerCode || payment.providerPaymentReference) {
      if (normalizeProviderCode(payment.providerCode) !== this.providerCode ||
          String(payment.providerPaymentReference || '') !== session.providerPaymentReference) {
        throw new PaymentIntegrationConflictError('Provider session does not match the canonical payment binding');
      }
    } else {
      try {
        canonicalPayment = await this.repository.bindPaymentProviderSession({
          paymentId: payment.paymentId,
          providerCode: this.providerCode,
          providerPaymentReference: session.providerPaymentReference,
          providerStatus: 'SESSION_CREATED',
          sessionCreatedAt: this._nowIso()
        });
      } catch (error) {
        if (String(error?.code || '').startsWith('PAYMENT_PROVIDER_')) {
          const conflict = new PaymentIntegrationConflictError(error.message || 'Payment provider binding conflict');
          conflict.code = error.code;
          throw conflict;
        }
        throw error;
      }
    }

    await this._audit(actor, canonicalPayment);
    return Object.freeze({
      payment: canonicalPayment,
      checkoutUrl: session.checkoutUrl,
      expiresAt: session.expiresAt
    });
  }
}

module.exports = {
  PaymentIntegrationService,
  PaymentIntegrationNotFoundError,
  PaymentIntegrationValidationError,
  PaymentIntegrationConflictError
};
