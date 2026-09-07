'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PaymentProviderContractError,
  assertPaymentProvider,
  DevelopmentPaymentProvider
} = require('../../services/api/src/payment-provider');

test('payment provider contract requires capabilities session creation and webhook verification', () => {
  assert.throws(() => assertPaymentProvider(null), PaymentProviderContractError);
  assert.throws(() => assertPaymentProvider({ capabilities() {} }), /createPaymentSession/i);
  assert.throws(() => assertPaymentProvider({ capabilities() {}, createPaymentSession() {} }), /verifyWebhook/i);
});

test('production payment provider must attest stable provider code and webhook verification', () => {
  const noCode = {
    capabilities() { return { webhookVerification: true, developmentOnly: false }; },
    async createPaymentSession() {},
    async verifyWebhook() {}
  };
  assert.throws(() => assertPaymentProvider(noCode, { production: true }), /provider code/i);

  const noVerification = {
    capabilities() { return { providerCode: 'approved-gateway', webhookVerification: false, developmentOnly: false }; },
    async createPaymentSession() {},
    async verifyWebhook() {}
  };
  assert.throws(() => assertPaymentProvider(noVerification, { production: true }), /webhook verification/i);
});

test('development payment provider is deterministic and explicitly development-only', async () => {
  const provider = new DevelopmentPaymentProvider();
  const capabilities = provider.capabilities();
  assert.equal(capabilities.providerCode, 'development');
  assert.equal(capabilities.webhookVerification, true);
  assert.equal(capabilities.developmentOnly, true);
  assert.throws(() => assertPaymentProvider(provider, { production: true }), /development-only/i);

  const first = await provider.createPaymentSession({
    paymentId: 'PAY-1', amountMinor: 12500, currency: 'PGK', idempotencyKey: 'idem-1'
  });
  const second = await provider.createPaymentSession({
    paymentId: 'PAY-1', amountMinor: 12500, currency: 'PGK', idempotencyKey: 'idem-1'
  });
  assert.deepEqual(second, first);
  assert.equal(first.providerCode, 'development');
  assert.equal(first.providerPaymentReference, 'dev:PAY-1');
  assert.equal(typeof first.checkoutUrl, 'string');
});
