'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPaymentRuntime } = require('../../services/api/src/payment-runtime');
const { DevelopmentPaymentProvider } = require('../../services/api/src/payment-provider');

function productionProvider() {
  return {
    capabilities() {
      return {
        providerCode: 'approved-gateway',
        webhookVerification: true,
        developmentOnly: false
      };
    },
    async createPaymentSession() {},
    async verifyWebhook() {}
  };
}

test('payment integration defaults safely to disabled when no mode is configured', () => {
  const runtime = createPaymentRuntime({ env: {} });
  assert.deepEqual(runtime, {
    enabled: false,
    mode: 'disabled',
    provider: null,
    providerCode: null
  });
});

test('production payment integration also defaults safely to disabled', () => {
  const runtime = createPaymentRuntime({ env: { NODE_ENV: 'production' } });
  assert.deepEqual(runtime, {
    enabled: false,
    mode: 'disabled',
    provider: null,
    providerCode: null
  });
});

test('production rejects development payment integration mode', () => {
  assert.throws(
    () => createPaymentRuntime({
      env: {
        NODE_ENV: 'production',
        DCIECMS_PAYMENT_INTEGRATION_MODE: 'development'
      }
    }),
    /development.*forbidden.*production/i
  );
});

test('enabled mode requires an injected production-capable provider', () => {
  assert.throws(
    () => createPaymentRuntime({
      env: {
        NODE_ENV: 'production',
        DCIECMS_PAYMENT_INTEGRATION_MODE: 'enabled'
      }
    }),
    /provider.*required/i
  );

  assert.throws(
    () => createPaymentRuntime({
      env: {
        NODE_ENV: 'production',
        DCIECMS_PAYMENT_INTEGRATION_MODE: 'enabled'
      },
      provider: new DevelopmentPaymentProvider()
    }),
    /development-only/i
  );
});

test('unknown payment integration mode is rejected rather than falling back', () => {
  assert.throws(
    () => createPaymentRuntime({
      env: { DCIECMS_PAYMENT_INTEGRATION_MODE: 'automatic' }
    }),
    /must be disabled, development, or enabled/i
  );
});

test('development mode returns an explicit development-only provider', () => {
  const runtime = createPaymentRuntime({
    env: {
      NODE_ENV: 'test',
      DCIECMS_PAYMENT_INTEGRATION_MODE: 'development'
    }
  });

  assert.equal(runtime.enabled, true);
  assert.equal(runtime.mode, 'development');
  assert.equal(runtime.providerCode, 'development');
  assert.equal(runtime.provider instanceof DevelopmentPaymentProvider, true);
});

test('enabled mode accepts an injected production-capable provider', () => {
  const provider = productionProvider();
  const runtime = createPaymentRuntime({
    env: {
      NODE_ENV: 'production',
      DCIECMS_PAYMENT_INTEGRATION_MODE: 'enabled'
    },
    provider
  });

  assert.equal(runtime.enabled, true);
  assert.equal(runtime.mode, 'enabled');
  assert.equal(runtime.provider, provider);
  assert.equal(runtime.providerCode, 'approved-gateway');
});
