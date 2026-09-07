'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');

const { createHttpApp } = require('../../services/api/src/http-app');
const { PaymentGatewayVerificationError } = require('../../services/api/src/payment-gateway-verifier');

async function withGatewayServer({ verifier, paymentGatewayService, actorResolver } = {}, fn) {
  let actorCalls = 0;
  const resolver = actorResolver || (async () => {
    actorCalls += 1;
    throw new Error('ordinary actor resolver must not run for payment callback route');
  });
  const handler = createHttpApp({}, resolver, { paymentGatewayVerifier:verifier, paymentGatewayService });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, () => actorCalls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function verifiedCallback(overrides = {}) {
  return {
    provider:'BANK',
    eventId:'evt-http-1',
    eventType:'PAYMENT_SUCCEEDED',
    paymentReference:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    providerPaymentReference:'gw-http-1',
    amountMinor:12500,
    currency:'PGK',
    occurredAt:'2026-09-07T03:30:00.000Z',
    ...overrides
  };
}

test('payment callback route verifies exact raw bytes before ordinary actor resolution and passes only canonical evidence plus server digest to service', async () => {
  const raw = '{ "event" : "paid", "spacing" : true }';
  const verifierCalls = [];
  const serviceCalls = [];
  const verifier = {
    async verify(input) {
      verifierCalls.push(input);
      return verifiedCallback();
    }
  };
  const paymentGatewayService = {
    async processVerifiedCallback(input) {
      serviceCalls.push(input);
      return { status:'APPLIED', replay:false, callbackId:'cb-1', paymentId:verifiedCallback().paymentReference, outcomeCode:'PAYMENT_CONFIRMED', failureCode:null };
    }
  };

  await withGatewayServer({ verifier, paymentGatewayService }, async (base, actorCalls) => {
    const response = await fetch(`${base}/api/integrations/payments/callback`, {
      method:'POST',
      headers:{
        'content-type':'application/json',
        'authorization':'Bearer USER_TOKEN_MUST_NOT_AUTHORIZE_CALLBACK',
        'x-provider-signature':'fixture-signature'
      },
      body:raw
    });

    assert.equal(response.status, 200);
    assert.equal(actorCalls(), 0);
    assert.equal(verifierCalls.length, 1);
    assert.equal(Buffer.isBuffer(verifierCalls[0].rawBody), true);
    assert.equal(verifierCalls[0].rawBody.toString('utf8'), raw);
    assert.equal(verifierCalls[0].headers['x-provider-signature'], 'fixture-signature');
    assert.match(verifierCalls[0].receivedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(serviceCalls.length, 1);
    assert.deepEqual(serviceCalls[0].verifiedCallback, verifiedCallback());
    assert.equal(
      serviceCalls[0].payloadDigestSha256,
      createHash('sha256').update(Buffer.from(raw)).digest('hex')
    );
    assert.equal(serviceCalls[0].receivedAt, verifierCalls[0].receivedAt);
    assert.deepEqual(await response.json(), {
      status:'APPLIED', replay:false, callbackId:'cb-1', paymentId:verifiedCallback().paymentReference,
      outcomeCode:'PAYMENT_CONFIRMED', failureCode:null
    });
  });
});

test('valid duplicate callback returns 200 canonical replay result without ordinary authentication', async () => {
  await withGatewayServer({
    verifier:{ async verify() { return verifiedCallback(); } },
    paymentGatewayService:{ async processVerifiedCallback() { return { status:'APPLIED', replay:true, callbackId:'cb-1', paymentId:verifiedCallback().paymentReference, outcomeCode:'PAYMENT_CONFIRMED', failureCode:null }; } }
  }, async (base, actorCalls) => {
    const response = await fetch(`${base}/api/integrations/payments/callback`, { method:'POST', body:'{}' });
    assert.equal(response.status, 200);
    assert.equal(actorCalls(), 0);
    assert.equal((await response.json()).replay, true);
  });
});

test('verified callback rejected for authoritative evidence conflict returns sanitized 409', async () => {
  await withGatewayServer({
    verifier:{ async verify() { return verifiedCallback(); } },
    paymentGatewayService:{ async processVerifiedCallback() { return { status:'REJECTED', replay:false, callbackId:'cb-1', paymentId:null, outcomeCode:null, failureCode:'PAYMENT_GATEWAY_AMOUNT_MISMATCH' }; } }
  }, async base => {
    const response = await fetch(`${base}/api/integrations/payments/callback`, { method:'POST', body:'{}' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error:'payment_callback_rejected',
      failureCode:'PAYMENT_GATEWAY_AMOUNT_MISMATCH'
    });
  });
});

test('callback event identity conflict returns sanitized 409 without internal detail', async () => {
  const conflict = new Error('SENSITIVE CONFLICT DETAIL');
  conflict.code = 'PAYMENT_CALLBACK_EVIDENCE_CONFLICT';
  await withGatewayServer({
    verifier:{ async verify() { return verifiedCallback(); } },
    paymentGatewayService:{ async processVerifiedCallback() { throw conflict; } }
  }, async base => {
    const response = await fetch(`${base}/api/integrations/payments/callback`, { method:'POST', body:'{}' });
    const text = await response.text();
    assert.equal(response.status, 409);
    assert.equal(text.includes('SENSITIVE CONFLICT DETAIL'), false);
    assert.deepEqual(JSON.parse(text), { error:'payment_callback_conflict' });
  });
});

test('payment callback route is unavailable when gateway dependencies are not configured', async () => {
  let actorCalls = 0;
  const server = http.createServer(createHttpApp({}, async () => { actorCalls += 1; return null; }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/integrations/payments/callback`, { method:'POST', body:'{}' });
    assert.equal(response.status, 404);
    assert.equal(actorCalls, 0);
    assert.deepEqual(await response.json(), { error:'not_found' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('payment verifier authentication malformed and availability failures map to sanitized HTTP responses', async () => {
  const cases = [
    [new PaymentGatewayVerificationError('SECRET invalid signature', { statusCode:401, code:'PAYMENT_CALLBACK_AUTHENTICITY_FAILED' }), 401, 'payment_callback_unauthorized'],
    [new PaymentGatewayVerificationError('SECRET malformed provider JSON', { statusCode:400, code:'PAYMENT_CALLBACK_MALFORMED' }), 400, 'payment_callback_invalid'],
    [new PaymentGatewayVerificationError('SECRET verifier backend failed', { statusCode:503, code:'PAYMENT_CALLBACK_VERIFIER_UNAVAILABLE' }), 503, 'payment_callback_unavailable']
  ];

  for (const [failure, status, errorCode] of cases) {
    await withGatewayServer({
      verifier:{ async verify() { throw failure; } },
      paymentGatewayService:{ async processVerifiedCallback() { throw new Error('service must not run'); } }
    }, async base => {
      const response = await fetch(`${base}/api/integrations/payments/callback`, { method:'POST', body:'sensitive-raw-body' });
      const text = await response.text();
      assert.equal(response.status, status);
      assert.equal(text.includes('SECRET'), false);
      assert.equal(text.includes('sensitive-raw-body'), false);
      assert.deepEqual(JSON.parse(text), { error:errorCode });
    });
  }
});
