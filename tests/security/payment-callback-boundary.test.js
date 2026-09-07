'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ConflictError, ValidationError } = require('../../services/api/src/dciecms-service');
const {
  PaymentCallbackAuthenticationError,
  PaymentCallbackUnavailableError
} = require('../../services/api/src/payment-callback-verifier');
const {
  PaymentCallbackConflictError,
  PaymentCallbackProviderNotFoundError,
  createPaymentCallbackHandler
} = require('../../services/api/src/payment-callback-handler');

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111';
const RECEIVED_AT = '2026-09-07T00:00:01.000Z';

function verified(overrides = {}) {
  return {
    providerCode: 'bank.png',
    providerEventId: 'evt-100',
    paymentId: PAYMENT_ID,
    providerReference: 'TX-100',
    status: 'CONFIRMED',
    amountMinor: 12500,
    currency: 'PGK',
    occurredAt: '2026-09-07T00:00:00.000Z',
    ...overrides
  };
}

test('handler sends exact raw bytes only to selected verifier and sends only normalized digest evidence to service', async () => {
  const rawBody = Buffer.from('{"payment":"ok", "signatureMaterial":"must-not-persist"}', 'utf8');
  let verifierInput = null;
  let serviceInput = null;
  let otherVerifierCalls = 0;
  const handler = createPaymentCallbackHandler({
    service: {
      async confirmPaymentFromCallback(input) {
        serviceInput = input;
        return { paymentId: input.paymentId, status: 'CONFIRMED' };
      }
    },
    verifiers: {
      'bank.png': {
        async verify(input) {
          verifierInput = input;
          return verified();
        }
      },
      'other-bank': {
        async verify() {
          otherVerifierCalls += 1;
          return verified({ providerCode: 'other-bank' });
        }
      }
    }
  });

  const result = await handler.handle({
    providerCode: 'Bank.PNG',
    headers: { 'x-provider-signature': 'raw-signature-secret' },
    rawBody,
    receivedAt: RECEIVED_AT
  });

  assert.deepEqual(result, { paymentId: PAYMENT_ID, status: 'CONFIRMED' });
  assert.equal(verifierInput.rawBody, rawBody);
  assert.equal(verifierInput.receivedAt, RECEIVED_AT);
  assert.equal(verifierInput.headers['x-provider-signature'], 'raw-signature-secret');
  assert.equal(otherVerifierCalls, 0);
  assert.equal(serviceInput.bodySha256, createHash('sha256').update(rawBody).digest('hex'));
  assert.equal(Object.prototype.hasOwnProperty.call(serviceInput, 'rawBody'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(serviceInput, 'headers'), false);
  assert.equal(JSON.stringify(serviceInput).includes('raw-signature-secret'), false);
  assert.equal(JSON.stringify(serviceInput).includes('must-not-persist'), false);
});

test('verified provider must exactly match the server-selected route provider', async () => {
  let serviceCalls = 0;
  const handler = createPaymentCallbackHandler({
    service: { async confirmPaymentFromCallback() { serviceCalls += 1; } },
    verifiers: {
      'bank.png': { async verify() { return verified({ providerCode: 'other-bank' }); } }
    }
  });

  await assert.rejects(
    () => handler.handle({ providerCode: 'bank.png', headers: {}, rawBody: Buffer.from('{}'), receivedAt: RECEIVED_AT }),
    PaymentCallbackConflictError
  );
  assert.equal(serviceCalls, 0);
});

test('unconfigured provider fails before verifier or service work', async () => {
  const handler = createPaymentCallbackHandler({
    service: { async confirmPaymentFromCallback() { throw new Error('must not run'); } },
    verifiers: { 'bank.png': { async verify() { throw new Error('must not run'); } } }
  });

  await assert.rejects(
    () => handler.handle({ providerCode: 'unknown-bank', headers: {}, rawBody: Buffer.from('{}'), receivedAt: RECEIVED_AT }),
    PaymentCallbackProviderNotFoundError
  );
});

test('handler requires an exact Buffer raw body rather than reparsing caller data', async () => {
  const handler = createPaymentCallbackHandler({
    service: { async confirmPaymentFromCallback() {} },
    verifiers: { 'bank.png': { async verify() { return verified(); } } }
  });

  await assert.rejects(
    () => handler.handle({ providerCode: 'bank.png', headers: {}, rawBody: '{"x":1}', receivedAt: RECEIVED_AT }),
    /raw body/i
  );
});

test('provider authentication and availability failures remain distinct callback-boundary failures', async () => {
  for (const error of [
    new PaymentCallbackAuthenticationError('do not expose signature detail'),
    new PaymentCallbackUnavailableError('do not expose provider outage detail')
  ]) {
    const handler = createPaymentCallbackHandler({
      service: { async confirmPaymentFromCallback() { throw new Error('must not run'); } },
      verifiers: { 'bank.png': { async verify() { throw error; } } }
    });
    await assert.rejects(
      () => handler.handle({ providerCode: 'bank.png', headers: {}, rawBody: Buffer.from('{}'), receivedAt: RECEIVED_AT }),
      error.constructor
    );
  }
});

test('service conflicts and validation failures are translated into generic callback boundary classes', async () => {
  for (const [serviceError, expected] of [
    [new ConflictError('payment provider reference detail'), PaymentCallbackConflictError],
    [new ValidationError('internal normalized callback detail'), require('../../services/api/src/payment-callback-verifier').PaymentCallbackValidationError]
  ]) {
    const handler = createPaymentCallbackHandler({
      service: { async confirmPaymentFromCallback() { throw serviceError; } },
      verifiers: { 'bank.png': { async verify() { return verified(); } } }
    });
    await assert.rejects(
      () => handler.handle({ providerCode: 'bank.png', headers: {}, rawBody: Buffer.from('{}'), receivedAt: RECEIVED_AT }),
      expected
    );
  }
});
