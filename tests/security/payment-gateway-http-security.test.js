'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createHttpApp } = require('../../services/api/src/http-app');

async function run(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function callback() {
  return {
    provider:'BANK', eventId:'evt-sec-http-1', eventType:'PAYMENT_SUCCEEDED',
    paymentReference:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', providerPaymentReference:'gw-sec-http-1',
    amountMinor:5000, currency:'PGK', occurredAt:'2026-09-07T03:35:00.000Z'
  };
}

test('OIDC/user authorization material cannot substitute for payment gateway verification', async () => {
  let verifierCalls = 0;
  let serviceCalls = 0;
  const handler = createHttpApp({}, async () => ({
    userId:'fin-mgr', roles:['FIN-MGR'], courtIds:['COURT-A'], explicitGrants:[]
  }), {
    paymentGatewayVerifier:{ async verify() { verifierCalls += 1; const error = new Error('forged'); error.statusCode=401; error.code='PAYMENT_CALLBACK_AUTHENTICITY_FAILED'; throw error; } },
    paymentGatewayService:{ async processVerifiedCallback() { serviceCalls += 1; return {}; } }
  });

  await run(handler, async base => {
    const response = await fetch(`${base}/api/integrations/payments/callback`, {
      method:'POST',
      headers:{ authorization:'Bearer otherwise-valid-user-token', 'x-dev-sub':'fin-mgr', 'x-dev-roles':'FIN-MGR' },
      body:'{}'
    });
    assert.equal(response.status, 401);
  });
  assert.equal(verifierCalls, 1);
  assert.equal(serviceCalls, 0);
});

test('callback transport secrets and provider diagnostics never appear in error responses', async () => {
  const sentinel = 'PAYMENT_CALLBACK_SECRET_SENTINEL';
  const error = new Error(`provider stack ${sentinel}`);
  error.statusCode = 503;
  error.code = 'PAYMENT_CALLBACK_VERIFIER_UNAVAILABLE';
  const handler = createHttpApp({}, async () => null, {
    paymentGatewayVerifier:{ async verify() { throw error; } },
    paymentGatewayService:{ async processVerifiedCallback() { throw new Error('must not run'); } }
  });

  await run(handler, async base => {
    const response = await fetch(`${base}/api/integrations/payments/callback`, {
      method:'POST',
      headers:{ 'x-provider-signature':sentinel },
      body:`{"secret":"${sentinel}"}`
    });
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.equal(text.includes(sentinel), false);
  });
});

test('callback body is bounded before verifier execution', async () => {
  let verifierCalls = 0;
  const handler = createHttpApp({}, async () => null, {
    paymentGatewayVerifier:{ async verify() { verifierCalls += 1; return callback(); } },
    paymentGatewayService:{ async processVerifiedCallback() { return {status:'APPLIED'}; } },
    paymentGatewayMaxBodyBytes:64
  });

  await run(handler, async base => {
    const response = await fetch(`${base}/api/integrations/payments/callback`, {
      method:'POST',
      body:'x'.repeat(65)
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error:'payment_callback_too_large' });
  });
  assert.equal(verifierCalls, 0);
});

test('unexpected callback boundary errors are sanitized as 500', async () => {
  const sentinel = 'UNEXPECTED_PAYMENT_INTERNAL_SECRET';
  const handler = createHttpApp({}, async () => null, {
    paymentGatewayVerifier:{ async verify() { return callback(); } },
    paymentGatewayService:{ async processVerifiedCallback() { throw new Error(sentinel); } }
  });

  await run(handler, async base => {
    const response = await fetch(`${base}/api/integrations/payments/callback`, { method:'POST', body:'{}' });
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.equal(text.includes(sentinel), false);
    assert.deepEqual(JSON.parse(text), { error:'internal_error' });
  });
});
