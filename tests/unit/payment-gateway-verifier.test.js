'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PaymentGatewayVerificationError,
  assertPaymentGatewayVerifier,
  normalizeVerifiedPaymentCallback,
  ScriptedPaymentGatewayVerifier
} = require('../../services/api/src/payment-gateway-verifier');

function validCallback(overrides = {}) {
  return {
    provider: ' test ',
    eventId: ' evt-1 ',
    eventType: 'payment_succeeded',
    paymentReference: ' PAY-1 ',
    providerPaymentReference: ' gw-1 ',
    amountMinor: 12500,
    currency: 'pgk',
    occurredAt: '2026-09-07T02:00:00Z',
    ...overrides
  };
}

test('canonical payment callback normalizes supported success evidence', () => {
  const value = normalizeVerifiedPaymentCallback(validCallback());

  assert.deepEqual(value, {
    provider: 'TEST',
    eventId: 'evt-1',
    eventType: 'PAYMENT_SUCCEEDED',
    paymentReference: 'PAY-1',
    providerPaymentReference: 'gw-1',
    amountMinor: 12500,
    currency: 'PGK',
    occurredAt: '2026-09-07T02:00:00.000Z'
  });
  assert.equal(Object.isFrozen(value), true);
});

test('canonical payment callback accepts a verified failure event without changing money representation', () => {
  const value = normalizeVerifiedPaymentCallback(validCallback({ eventType:'PAYMENT_FAILED', amountMinor:0 }));
  assert.equal(value.eventType, 'PAYMENT_FAILED');
  assert.equal(value.amountMinor, 0);
});

test('canonical payment callback rejects floating, negative and unsafe integer amounts', () => {
  for (const amountMinor of [12.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => normalizeVerifiedPaymentCallback(validCallback({ amountMinor })),
      /amount/i
    );
  }
});

test('canonical payment callback rejects unsupported event types and malformed currencies', () => {
  assert.throws(
    () => normalizeVerifiedPaymentCallback(validCallback({ eventType:'REFUND' })),
    /event type/i
  );
  assert.throws(
    () => normalizeVerifiedPaymentCallback(validCallback({ currency:'PG' })),
    /currency/i
  );
});

test('canonical payment callback rejects invalid timestamps and blank identifiers', () => {
  assert.throws(
    () => normalizeVerifiedPaymentCallback(validCallback({ occurredAt:'not-a-date' })),
    /occurredAt|timestamp/i
  );
  assert.throws(
    () => normalizeVerifiedPaymentCallback(validCallback({ eventId:'   ' })),
    /eventId/i
  );
  assert.throws(
    () => normalizeVerifiedPaymentCallback(validCallback({ paymentReference:'' })),
    /paymentReference/i
  );
});

test('verifier contract requires verify and capabilities methods', () => {
  assert.throws(() => assertPaymentGatewayVerifier({}), /verify/i);
  assert.throws(() => assertPaymentGatewayVerifier({ verify: async () => ({}) }), /capabilities/i);
});

test('development scripted verifier is allowed only outside production', async () => {
  const verifier = new ScriptedPaymentGatewayVerifier([validCallback()]);

  assert.doesNotThrow(() => assertPaymentGatewayVerifier(verifier, { production:false }));
  assert.throws(
    () => assertPaymentGatewayVerifier(verifier, { production:true }),
    /development|production/i
  );

  const result = await verifier.verify({
    rawBody: Buffer.from('{"event":"ok"}'),
    headers: { 'x-test-signature':'fixture' },
    receivedAt: '2026-09-07T02:00:01.000Z'
  });
  assert.equal(result.eventId, 'evt-1');
});

test('production verifier must attest authenticity and replay-time validation', () => {
  const missingReplayProtection = {
    verify: async () => validCallback(),
    capabilities: () => ({
      developmentOnly:false,
      authenticityVerified:true,
      replayTimeValidated:false
    })
  };

  assert.throws(
    () => assertPaymentGatewayVerifier(missingReplayProtection, { production:true }),
    /replay|production/i
  );
});

test('verification errors expose bounded HTTP classification without raw provider diagnostics', () => {
  const error = new PaymentGatewayVerificationError('Callback authenticity failed', {
    statusCode:401,
    code:'PAYMENT_CALLBACK_AUTHENTICITY_FAILED'
  });

  assert.equal(error.statusCode, 401);
  assert.equal(error.code, 'PAYMENT_CALLBACK_AUTHENTICITY_FAILED');
  assert.equal(Object.hasOwn(error, 'rawBody'), false);
  assert.equal(Object.hasOwn(error, 'signature'), false);
});
