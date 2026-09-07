'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPaymentGatewayRuntime } = require('../../services/api/src/payment-gateway-runtime');
const { ScriptedPaymentGatewayVerifier } = require('../../services/api/src/payment-gateway-verifier');

function productionVerifier(overrides = {}) {
  return {
    async verify() { return {}; },
    capabilities() {
      return {
        developmentOnly:false,
        authenticityVerified:true,
        replayTimeValidated:true,
        ...overrides
      };
    }
  };
}

test('production rejects development callback mode before activation', () => {
  assert.throws(
    () => createPaymentGatewayRuntime({
      env:{ NODE_ENV:'production', DCIECMS_PAYMENT_GATEWAY_MODE:'development' }
    }),
    /forbidden|production/i
  );
});

test('production enabled mode rejects missing or development-only verifier', () => {
  assert.throws(
    () => createPaymentGatewayRuntime({
      env:{ NODE_ENV:'production', DCIECMS_PAYMENT_GATEWAY_MODE:'enabled' }
    }),
    /verifier/i
  );
  assert.throws(
    () => createPaymentGatewayRuntime({
      env:{ NODE_ENV:'production', DCIECMS_PAYMENT_GATEWAY_MODE:'enabled' },
      verifier:new ScriptedPaymentGatewayVerifier([])
    }),
    /development|production/i
  );
});

test('production enabled mode rejects verifier without authenticity or replay-time guarantees', () => {
  assert.throws(
    () => createPaymentGatewayRuntime({
      env:{ NODE_ENV:'production', DCIECMS_PAYMENT_GATEWAY_MODE:'enabled' },
      verifier:productionVerifier({ authenticityVerified:false })
    }),
    /authenticity|production/i
  );
  assert.throws(
    () => createPaymentGatewayRuntime({
      env:{ NODE_ENV:'production', DCIECMS_PAYMENT_GATEWAY_MODE:'enabled' },
      verifier:productionVerifier({ replayTimeValidated:false })
    }),
    /replay|production/i
  );
});

test('production disabled mode does not accept or expose callback verifier accidentally', () => {
  const runtime = createPaymentGatewayRuntime({
    env:{ NODE_ENV:'production', DCIECMS_PAYMENT_GATEWAY_MODE:'disabled' },
    verifier:productionVerifier()
  });
  assert.deepEqual(runtime, { enabled:false, mode:'disabled', verifier:null });
});
