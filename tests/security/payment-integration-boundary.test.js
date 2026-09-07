'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHttpApp } = require('../../services/api/src/http-app');

async function withApp(service, actorResolver, work) {
  const server = http.createServer(createHttpApp(service, actorResolver));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await work(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const actor = Object.freeze({
  userId: 'fin-a',
  roles: ['FIN'],
  courtIds: ['COURT-A'],
  explicitGrants: [],
  correlationId: 'corr-payment-security'
});

test('payment-session request body is bounded before service invocation', async () => {
  let sessionCalls = 0;
  const service = {
    paymentIntegrationMode: 'enabled',
    async createPaymentSession() {
      sessionCalls += 1;
      return { checkoutUrl: 'https://checkout.example.invalid/should-not-run', expiresAt: null };
    }
  };

  await withApp(service, async () => actor, async base => {
    const oversized = JSON.stringify({ returnPath: `/${'x'.repeat(20 * 1024)}` });
    const response = await fetch(`${base}/payments/pay-a/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'payload_too_large' });
  });

  assert.equal(sessionCalls, 0);
});

test('payment-session HTTP response exposes only ephemeral checkout metadata', async () => {
  const secret = 'PROVIDER_BINDING_SECRET_DO_NOT_EXPOSE';
  const service = {
    paymentIntegrationMode: 'enabled',
    async createPaymentSession() {
      return {
        payment: {
          paymentId: 'pay-a',
          providerCode: 'approved-gateway',
          providerPaymentReference: secret,
          providerStatus: 'SESSION_CREATED'
        },
        providerCode: 'approved-gateway',
        providerPaymentReference: secret,
        sessionToken: secret,
        checkoutUrl: 'https://checkout.example.invalid/session-a',
        expiresAt: '2026-09-07T03:00:00.000Z'
      };
    }
  };

  await withApp(service, async () => actor, async base => {
    const response = await fetch(`${base}/payments/pay-a/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    assert.equal(text.includes(secret), false);
    assert.deepEqual(JSON.parse(text), {
      checkoutUrl: 'https://checkout.example.invalid/session-a',
      expiresAt: '2026-09-07T03:00:00.000Z'
    });
  });
});
