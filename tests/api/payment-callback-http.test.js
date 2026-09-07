'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHttpApp } = require('../../services/api/src/http-app');
const {
  PaymentCallbackAuthenticationError,
  PaymentCallbackUnavailableError
} = require('../../services/api/src/payment-callback-verifier');
const {
  PaymentCallbackConflictError,
  PaymentCallbackBodyTooLargeError
} = require('../../services/api/src/payment-callback-handler');

async function withServer({ service = {}, actorResolver, paymentCallbackHandler, callbackMaxBodyBytes }, fn) {
  const handler = createHttpApp(service, actorResolver, { paymentCallbackHandler, callbackMaxBodyBytes });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('exact payment callback route is handled before OIDC actor resolution and preserves raw bytes', async () => {
  let actorCalls = 0;
  let captured = null;
  const paymentCallbackHandler = {
    async handle(input) {
      captured = input;
      return { paymentId: 'p-1', status: 'CONFIRMED' };
    }
  };

  await withServer({
    actorResolver: async () => {
      actorCalls += 1;
      throw new Error('OIDC resolver must not execute on callback route');
    },
    paymentCallbackHandler
  }, async base => {
    const raw = Buffer.from('{"x":1, "spacing":"preserved"}', 'utf8');
    const response = await fetch(`${base}/integrations/payments/Bank.PNG/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-provider-signature': 'signed' },
      body: raw
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { paymentId: 'p-1', status: 'CONFIRMED' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(actorCalls, 0);
    assert.equal(captured.providerCode, 'Bank.PNG');
    assert.equal(Buffer.isBuffer(captured.rawBody), true);
    assert.deepEqual(captured.rawBody, raw);
    assert.equal(captured.headers['x-provider-signature'], 'signed');
    assert.match(captured.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('all unrelated routes still require actor resolution', async () => {
  let actorCalls = 0;
  await withServer({
    service: { async listRegistryQueue() { return []; } },
    actorResolver: async () => {
      actorCalls += 1;
      return null;
    },
    paymentCallbackHandler: { async handle() { throw new Error('must not run'); } }
  }, async base => {
    const response = await fetch(`${base}/registry/filings`);
    assert.equal(response.status, 401);
    assert.equal(actorCalls, 1);
  });
});

test('callback route is not exposed when callback handler is not configured and still does not invoke OIDC', async () => {
  let actorCalls = 0;
  await withServer({
    actorResolver: async () => {
      actorCalls += 1;
      return { userId: 'unexpected' };
    },
    paymentCallbackHandler: null
  }, async base => {
    const response = await fetch(`${base}/integrations/payments/bank.png/callback`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.equal(actorCalls, 0);
  });
});

test('callback raw body limit rejects before verifier/service execution', async () => {
  let callbackCalls = 0;
  await withServer({
    actorResolver: async () => { throw new Error('must not run'); },
    paymentCallbackHandler: {
      async handle() {
        callbackCalls += 1;
        return {};
      }
    },
    callbackMaxBodyBytes: 4
  }, async base => {
    const response = await fetch(`${base}/integrations/payments/bank.png/callback`, {
      method: 'POST',
      body: Buffer.from('12345')
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: 'callback_validation_error' });
    assert.equal(callbackCalls, 0);
  });
});

test('callback authentication failure is sanitized and never emits a Bearer challenge', async () => {
  await withServer({
    actorResolver: async () => { throw new Error('must not run'); },
    paymentCallbackHandler: {
      async handle() {
        throw new PaymentCallbackAuthenticationError('expected signature super-secret');
      }
    }
  }, async base => {
    const response = await fetch(`${base}/integrations/payments/bank.png/callback`, { method: 'POST', body: '{}' });
    const text = await response.text();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.equal(text, '{"error":"callback_unauthorized"}');
    assert.equal(text.includes('super-secret'), false);
  });
});

test('callback verifier outage and state conflict map to generic callback errors', async () => {
  for (const [error, status, code] of [
    [new PaymentCallbackUnavailableError('provider TLS diagnostic'), 503, 'callback_unavailable'],
    [new PaymentCallbackConflictError('provider reference collision detail'), 409, 'callback_conflict']
  ]) {
    await withServer({
      actorResolver: async () => { throw new Error('must not run'); },
      paymentCallbackHandler: { async handle() { throw error; } }
    }, async base => {
      const response = await fetch(`${base}/integrations/payments/bank.png/callback`, { method: 'POST', body: '{}' });
      const text = await response.text();
      assert.equal(response.status, status);
      assert.deepEqual(JSON.parse(text), { error: code });
      assert.equal(text.includes(error.message), false);
    });
  }
});

test('callback body-too-large error type remains callback-specific', () => {
  const error = new PaymentCallbackBodyTooLargeError();
  assert.equal(error.name, 'PaymentCallbackBodyTooLargeError');
});
