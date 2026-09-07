'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PaymentCallbackAuthenticationError,
  PaymentCallbackUnavailableError,
  PaymentCallbackValidationError,
  normalizeProviderCode,
  normalizeVerifiedPaymentCallback,
  assertPaymentCallbackVerifier,
  ScriptedPaymentCallbackVerifier
} = require('../../services/api/src/payment-callback-verifier');

const paymentId = '11111111-1111-4111-8111-111111111111';
const receivedAt = '2026-09-07T00:00:01.000Z';
const bodySha256 = 'a'.repeat(64);

function validCallback(overrides = {}) {
  return {
    providerCode: 'bank.png',
    providerEventId: 'evt-100',
    paymentId,
    providerReference: 'TX-100',
    status: 'CONFIRMED',
    amountMinor: 12500,
    currency: 'pgk',
    occurredAt: '2026-09-07T00:00:00.000Z',
    ...overrides
  };
}

test('provider codes are normalized to lower case and tightly bounded', () => {
  assert.equal(normalizeProviderCode(' Bank.PNG-1 '), 'bank.png-1');
  for (const invalid of ['', ' ', '../bank', '_bank', 'bank/pay', 'a'.repeat(65)]) {
    assert.throws(() => normalizeProviderCode(invalid), PaymentCallbackValidationError);
  }
});

test('verified callbacks normalize only confirmed authoritative fields', () => {
  const callback = normalizeVerifiedPaymentCallback(validCallback(), { receivedAt, bodySha256 });

  assert.deepEqual(callback, {
    providerCode: 'bank.png',
    providerEventId: 'evt-100',
    paymentId,
    providerReference: 'TX-100',
    status: 'CONFIRMED',
    amountMinor: 12500,
    currency: 'PGK',
    occurredAt: '2026-09-07T00:00:00.000Z',
    receivedAt,
    bodySha256
  });
  assert.equal(Object.isFrozen(callback), true);
});

test('verified callback rejects unsupported status and malformed authoritative values', () => {
  const cases = [
    validCallback({ status: 'FAILED' }),
    validCallback({ amountMinor: 0 }),
    validCallback({ amountMinor: 1.5 }),
    validCallback({ currency: 'PG' }),
    validCallback({ paymentId: 'not-a-uuid' }),
    validCallback({ providerEventId: '' }),
    validCallback({ providerEventId: 'x'.repeat(181) }),
    validCallback({ providerReference: '' }),
    validCallback({ providerReference: 'x'.repeat(161) }),
    validCallback({ occurredAt: 'not-a-date' })
  ];

  for (const value of cases) {
    assert.throws(
      () => normalizeVerifiedPaymentCallback(value, { receivedAt, bodySha256 }),
      PaymentCallbackValidationError
    );
  }
});

test('received timestamp and body digest must be server-supplied valid evidence', () => {
  assert.throws(
    () => normalizeVerifiedPaymentCallback(validCallback(), { receivedAt: 'bad', bodySha256 }),
    PaymentCallbackValidationError
  );
  assert.throws(
    () => normalizeVerifiedPaymentCallback(validCallback(), { receivedAt, bodySha256: 'abc' }),
    PaymentCallbackValidationError
  );
});

test('verifier contract requires verify()', () => {
  assert.throws(() => assertPaymentCallbackVerifier({}), /verify/i);
  assert.doesNotThrow(() => assertPaymentCallbackVerifier(new ScriptedPaymentCallbackVerifier([])));
});

test('scripted verifier returns deterministic verified evidence without embedding credentials', async () => {
  const verifier = new ScriptedPaymentCallbackVerifier([validCallback()]);
  const rawBody = Buffer.from('{"payment":"ok"}', 'utf8');
  const result = await verifier.verify({ headers: {}, rawBody, receivedAt });

  assert.deepEqual(result, validCallback());
  assert.equal(verifier.developmentOnly, true);
  assert.equal(Object.prototype.hasOwnProperty.call(verifier, 'secret'), false);
});

test('scripted verifier can deterministically surface authentication and availability failures', async () => {
  const authError = new PaymentCallbackAuthenticationError();
  const unavailable = new PaymentCallbackUnavailableError();
  const verifier = new ScriptedPaymentCallbackVerifier([authError, unavailable]);

  await assert.rejects(() => verifier.verify({ headers: {}, rawBody: Buffer.alloc(0), receivedAt }), PaymentCallbackAuthenticationError);
  await assert.rejects(() => verifier.verify({ headers: {}, rawBody: Buffer.alloc(0), receivedAt }), PaymentCallbackUnavailableError);
});
