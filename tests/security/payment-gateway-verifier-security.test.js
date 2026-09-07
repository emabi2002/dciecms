'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeVerifiedPaymentCallback,
  assertPaymentGatewayVerifier
} = require('../../services/api/src/payment-gateway-verifier');

function base(overrides = {}) {
  return {
    provider:'BANK',
    eventId:'evt-sec-1',
    eventType:'PAYMENT_SUCCEEDED',
    paymentReference:'PAY-SEC-1',
    providerPaymentReference:'provider-sec-1',
    amountMinor:5000,
    currency:'PGK',
    occurredAt:'2026-09-07T02:00:00.000Z',
    ...overrides
  };
}

test('canonical callback discards untrusted transport and secret-shaped fields', () => {
  const result = normalizeVerifiedPaymentCallback(base({
    rawBody:'SECRET-PAYLOAD',
    signature:'secret-signature',
    authorization:'Bearer secret',
    secret:'merchant-secret',
    diagnostics:{ providerStack:'sensitive' }
  }));

  assert.deepEqual(Object.keys(result).sort(), [
    'amountMinor',
    'currency',
    'eventId',
    'eventType',
    'occurredAt',
    'paymentReference',
    'provider',
    'providerPaymentReference'
  ].sort());

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('SECRET-PAYLOAD'), false);
  assert.equal(serialized.includes('secret-signature'), false);
  assert.equal(serialized.includes('merchant-secret'), false);
  assert.equal(serialized.includes('providerStack'), false);
});

test('canonical callback rejects overlong security identifiers', () => {
  assert.throws(() => normalizeVerifiedPaymentCallback(base({ provider:'P'.repeat(81) })), /provider/i);
  assert.throws(() => normalizeVerifiedPaymentCallback(base({ eventId:'E'.repeat(181) })), /eventId/i);
  assert.throws(() => normalizeVerifiedPaymentCallback(base({ paymentReference:'R'.repeat(121) })), /paymentReference/i);
  assert.throws(() => normalizeVerifiedPaymentCallback(base({ providerPaymentReference:'G'.repeat(181) })), /providerPaymentReference/i);
});

test('production verifier rejects developmentOnly capability even if authenticity flags are true', () => {
  const verifier = {
    verify: async () => base(),
    capabilities: () => ({
      developmentOnly:true,
      authenticityVerified:true,
      replayTimeValidated:true
    })
  };

  assert.throws(
    () => assertPaymentGatewayVerifier(verifier, { production:true }),
    /development|production/i
  );
});

test('production verifier rejects missing authenticity attestation', () => {
  const verifier = {
    verify: async () => base(),
    capabilities: () => ({
      developmentOnly:false,
      authenticityVerified:false,
      replayTimeValidated:true
    })
  };

  assert.throws(
    () => assertPaymentGatewayVerifier(verifier, { production:true }),
    /authenticity|production/i
  );
});
