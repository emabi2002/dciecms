'use strict';

class PaymentProviderContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaymentProviderContractError';
  }
}

function requireMethod(provider, name) {
  if (!provider || typeof provider[name] !== 'function') {
    throw new PaymentProviderContractError(`Payment provider must expose ${name}()`);
  }
}

function normalizeProviderCode(value) {
  const code = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(code)) {
    throw new PaymentProviderContractError('Payment provider capabilities must include a stable provider code');
  }
  return code;
}

function assertPaymentProvider(provider, { production = false } = {}) {
  requireMethod(provider, 'capabilities');
  requireMethod(provider, 'createPaymentSession');
  requireMethod(provider, 'verifyWebhook');

  const capabilities = provider.capabilities();
  if (!capabilities || typeof capabilities !== 'object') {
    throw new PaymentProviderContractError('Payment provider capabilities() must return an object');
  }

  const providerCode = normalizeProviderCode(capabilities.providerCode);
  if (capabilities.webhookVerification !== true) {
    throw new PaymentProviderContractError('Payment provider must support webhook verification');
  }
  if (production && capabilities.developmentOnly === true) {
    throw new PaymentProviderContractError('Development-only payment provider cannot be used in production');
  }

  return Object.freeze({
    provider,
    capabilities: Object.freeze({
      providerCode,
      webhookVerification: true,
      developmentOnly: capabilities.developmentOnly === true
    })
  });
}

function requireText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new PaymentProviderContractError(`${label} is required`);
  return normalized;
}

class DevelopmentPaymentProvider {
  constructor() {
    this.sessions = new Map();
  }

  capabilities() {
    return Object.freeze({
      providerCode: 'development',
      webhookVerification: true,
      developmentOnly: true
    });
  }

  async createPaymentSession({ paymentId, amountMinor, currency, idempotencyKey } = {}) {
    const id = requireText(paymentId, 'paymentId');
    const key = requireText(idempotencyKey, 'idempotencyKey');
    const amount = Number(amountMinor);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new PaymentProviderContractError('amountMinor must be a positive integer');
    }
    const normalizedCurrency = requireText(currency, 'currency').toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      throw new PaymentProviderContractError('currency must be a 3-letter code');
    }

    const existing = this.sessions.get(key);
    if (existing) return existing;

    const session = Object.freeze({
      providerCode: 'development',
      providerPaymentReference: `dev:${id}`,
      paymentId: id,
      amountMinor: amount,
      currency: normalizedCurrency,
      checkoutUrl: `https://payments.example.invalid/development/${encodeURIComponent(id)}`
    });
    this.sessions.set(key, session);
    return session;
  }

  async verifyWebhook({ verifiedEvent } = {}) {
    if (!verifiedEvent || typeof verifiedEvent !== 'object') {
      throw new PaymentProviderContractError('Development webhook fixture requires verifiedEvent');
    }
    return Object.freeze(JSON.parse(JSON.stringify(verifiedEvent)));
  }
}

module.exports = {
  PaymentProviderContractError,
  assertPaymentProvider,
  DevelopmentPaymentProvider
};
