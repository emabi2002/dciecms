'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHttpApp } = require('../../services/api/src/http-app');
const {
  PaymentWebhookVerificationError
} = require('../../services/api/src/payment-webhook-service');

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
  correlationId: 'corr-http-payment'
});

const jsonHeaders = Object.freeze({ 'content-type': 'application/json' });

test('POST /payments/:id/sessions is authenticated, non-cacheable and maps only the session request body', async () => {
  const calls = [];
  const service = {
    paymentIntegrationMode: 'enabled',
    async createPaymentSession(receivedActor, paymentId, input) {
      calls.push({ receivedActor, paymentId, input });
      return {
        payment: { paymentId, status: 'PENDING', amountMinor: 12500, currency: 'PGK' },
        checkoutUrl: 'https://checkout.example.invalid/session-a',
        expiresAt: null
      };
    }
  };

  await withApp(service, async () => actor, async base => {
    const response = await fetch(`${base}/payments/pay-a/sessions`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ returnPath: '/payments/pay-a' })
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.checkoutUrl, 'https://checkout.example.invalid/session-a');
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].receivedActor, actor);
  assert.equal(calls[0].paymentId, 'pay-a');
  assert.deepEqual(calls[0].input, { returnPath: '/payments/pay-a' });
});

test('provider webhook bypasses browser authentication and passes the exact bounded raw bytes and headers to verification', async () => {
  const expected = Buffer.from('{"event":"provider-signed-body"}', 'utf8');
  let actorResolutionCalls = 0;
  let received = null;
  const service = {
    paymentIntegrationMode: 'enabled',
    paymentWebhookService: {
      maxBodyBytes: 1024,
      async ingest(input) {
        received = input;
        return { eventRecordId: 'event-a', processingStatus: 'RECEIVED' };
      }
    }
  };

  await withApp(service, async () => {
    actorResolutionCalls += 1;
    throw new Error('browser authentication must not run for provider webhook');
  }, async base => {
    const response = await fetch(`${base}/payment-provider/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-provider-signature': 'signed-proof'
      },
      body: expected
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true });
  });

  assert.equal(actorResolutionCalls, 0);
  assert.ok(Buffer.isBuffer(received.rawBody));
  assert.deepEqual(received.rawBody, expected);
  assert.equal(received.headers['x-provider-signature'], 'signed-proof');
});

test('provider webhook body is bounded before verification is invoked', async () => {
  let ingestCalls = 0;
  const service = {
    paymentIntegrationMode: 'enabled',
    paymentWebhookService: {
      maxBodyBytes: 4,
      async ingest() {
        ingestCalls += 1;
        return { eventRecordId: 'must-not-exist' };
      }
    }
  };

  await withApp(service, async () => null, async base => {
    const response = await fetch(`${base}/payment-provider/webhook`, {
      method: 'POST',
      body: Buffer.from('12345')
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'payload_too_large' });
  });
  assert.equal(ingestCalls, 0);
});

test('invalid provider proof returns a sanitized provider-authentication failure', async () => {
  const sentinel = 'WEBHOOK_SIGNATURE_SENTINEL_DO_NOT_LEAK';
  const service = {
    paymentIntegrationMode: 'enabled',
    paymentWebhookService: {
      maxBodyBytes: 1024,
      async ingest() {
        throw new PaymentWebhookVerificationError(`invalid ${sentinel}`);
      }
    }
  };

  await withApp(service, async () => null, async base => {
    const response = await fetch(`${base}/payment-provider/webhook`, {
      method: 'POST',
      body: Buffer.from('{}')
    });
    const text = await response.text();
    assert.equal(response.status, 401);
    assert.equal(text.includes(sentinel), false);
    assert.deepEqual(JSON.parse(text), { error: 'provider_authentication_failed' });
  });
});

test('enabled provider integration blocks the legacy manual external-payment confirmation route', async () => {
  let confirmCalls = 0;
  const service = {
    paymentIntegrationMode: 'enabled',
    async confirmPayment() {
      confirmCalls += 1;
      return { paymentId: 'pay-a', status: 'CONFIRMED' };
    }
  };

  await withApp(service, async () => ({ ...actor, roles: ['FIN-MGR'] }), async base => {
    const response = await fetch(`${base}/payments/pay-a/confirm`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        providerReference: 'CALLER-CANNOT-MANUFACTURE-SUCCESS',
        amountMinor: 12500,
        currency: 'PGK',
        status: 'SUCCEEDED'
      })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'provider_confirmation_required' });
  });
  assert.equal(confirmCalls, 0);
});

test('provider and session internal failures never echo provider secrets', async () => {
  const sentinel = 'MERCHANT_SECRET_SENTINEL_DO_NOT_LEAK';
  const service = {
    paymentIntegrationMode: 'enabled',
    async createPaymentSession() {
      throw new Error(`provider outage ${sentinel}`);
    }
  };

  await withApp(service, async () => actor, async base => {
    const response = await fetch(`${base}/payments/pay-a/sessions`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}'
    });
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.equal(text.includes(sentinel), false);
    assert.deepEqual(JSON.parse(text), { error: 'internal_error' });
  });
});
