'use strict';

const {
  assertPaymentProvider,
  DevelopmentPaymentProvider
} = require('./payment-provider');

function normalizeMode(env = process.env) {
  const raw = String(env?.DCIECMS_PAYMENT_INTEGRATION_MODE || '').trim().toLowerCase();
  if (!raw) return 'disabled';
  if (!['disabled', 'development', 'enabled'].includes(raw)) {
    throw new TypeError('DCIECMS_PAYMENT_INTEGRATION_MODE must be disabled, development, or enabled');
  }
  return raw;
}

function createPaymentRuntime({ env = process.env, provider = null } = {}) {
  const production = String(env?.NODE_ENV || '').trim().toLowerCase() === 'production';
  const mode = normalizeMode(env);

  if (mode === 'disabled') {
    return Object.freeze({
      enabled: false,
      mode: 'disabled',
      provider: null,
      providerCode: null
    });
  }

  if (mode === 'development') {
    if (production) {
      throw new TypeError('Development payment integration mode is forbidden in production');
    }
    const selected = provider || new DevelopmentPaymentProvider();
    const verified = assertPaymentProvider(selected, { production: false });
    return Object.freeze({
      enabled: true,
      mode,
      provider: selected,
      providerCode: verified.capabilities.providerCode
    });
  }

  if (!provider) {
    throw new TypeError('Production payment provider is required when payment integration is enabled');
  }
  const verified = assertPaymentProvider(provider, { production: true });
  return Object.freeze({
    enabled: true,
    mode: 'enabled',
    provider,
    providerCode: verified.capabilities.providerCode
  });
}

module.exports = {
  createPaymentRuntime
};
