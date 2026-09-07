'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPaymentGatewayRuntime
} = require('../../services/api/src/payment-gateway-runtime');
const {
  ScriptedPaymentGatewayVerifier
} = require('../../services/api/src/payment-gateway-verifier');

function productionVerifier() {
  return {
    async verify() { throw new Error('not invoked by runtime tests'); },
    capabilities() {
      return {
        developmentOnly:false,
        authenticityVerified:true,
        replayTimeValidated:true
      };
    }
  };
}

test('payment gateway runtime is disabled by default in non-production and production', () => {
  const development = createPaymentGatewayRuntime({ env:{} });
  assert.deepEqual(development, { enabled:false, mode:'disabled', verifier:null });

  const production = createPaymentGatewayRuntime({ env:{ NODE_ENV:'production' } });
  assert.deepEqual(production, { enabled:false, mode:'disabled', verifier:null });
});

test('explicit development mode uses deterministic development verifier outside production', () => {
  const runtime = createPaymentGatewayRuntime({
    env:{ NODE_ENV:'development', DCIECMS_PAYMENT_GATEWAY_MODE:'development' }
  });

  assert.equal(runtime.enabled, true);
  assert.equal(runtime.mode, 'development');
  assert.ok(runtime.verifier instanceof ScriptedPaymentGatewayVerifier);
});

test('explicit development mode may use an injected deterministic verifier outside production', () => {
  const verifier = new ScriptedPaymentGatewayVerifier([]);
  const runtime = createPaymentGatewayRuntime({
    env:{ DCIECMS_PAYMENT_GATEWAY_MODE:'development' },
    verifier
  });
  assert.equal(runtime.verifier, verifier);
});

test('enabled mode requires an injected production-capable verifier even outside production', () => {
  assert.throws(
    () => createPaymentGatewayRuntime({ env:{ DCIECMS_PAYMENT_GATEWAY_MODE:'enabled' } }),
    /verifier/i
  );
  assert.throws(
    () => createPaymentGatewayRuntime({
      env:{ DCIECMS_PAYMENT_GATEWAY_MODE:'enabled' },
      verifier:new ScriptedPaymentGatewayVerifier([])
    }),
    /development|production/i
  );

  const verifier = productionVerifier();
  const runtime = createPaymentGatewayRuntime({
    env:{ DCIECMS_PAYMENT_GATEWAY_MODE:'enabled' },
    verifier
  });
  assert.equal(runtime.enabled, true);
  assert.equal(runtime.mode, 'enabled');
  assert.equal(runtime.verifier, verifier);
});

test('invalid payment gateway mode is rejected', () => {
  assert.throws(
    () => createPaymentGatewayRuntime({ env:{ DCIECMS_PAYMENT_GATEWAY_MODE:'automatic' } }),
    /disabled, development, or enabled/i
  );
});
