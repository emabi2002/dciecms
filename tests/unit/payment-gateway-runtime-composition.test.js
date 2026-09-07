'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntimeService } = require('../../services/api/src/runtime-service');
const { PostgresTransactionManager } = require('../../services/api/src/postgres-transaction-manager');
const { PostgresPaymentCallbackStore } = require('../../services/api/src/postgres-payment-callback-store');
const { PaymentGatewayService } = require('../../services/api/src/payment-gateway-service');
const { ScriptedPaymentGatewayVerifier } = require('../../services/api/src/payment-gateway-verifier');

class FakePool {
  constructor(options) { this.options = options; }
  async query() { return { rows:[] }; }
  async connect() { throw new Error('not used by runtime composition constructor'); }
}

test('enabled callback runtime requires durable PostgreSQL persistence', () => {
  assert.throws(
    () => createRuntimeService({
      env:{ DCIECMS_PAYMENT_GATEWAY_MODE:'development' },
      paymentGatewayVerifier:new ScriptedPaymentGatewayVerifier([])
    }),
    /DATABASE_URL|durable|PostgreSQL/i
  );
});

test('persistent development callback runtime composes verifier store and service over the same transaction manager', () => {
  const verifier = new ScriptedPaymentGatewayVerifier([]);
  const service = createRuntimeService({
    env:{
      DATABASE_URL:'postgres://example/db',
      DCIECMS_PAYMENT_GATEWAY_MODE:'development',
      DCIECMS_DOCUMENT_PIPELINE_MODE:'disabled'
    },
    PoolClass:FakePool,
    paymentGatewayVerifier:verifier
  });

  assert.equal(service.paymentGatewayVerifier, verifier);
  assert.ok(service.paymentCallbackStore instanceof PostgresPaymentCallbackStore);
  assert.ok(service.paymentGatewayService instanceof PaymentGatewayService);
  assert.ok(service.repository.db instanceof PostgresTransactionManager);
  assert.equal(service.paymentCallbackStore.db, service.repository.db);
  assert.equal(service.paymentGatewayService.transactionManager, service.repository.db);
  assert.equal(service.paymentGatewayService.repository, service.repository);
  assert.equal(service.paymentGatewayService.auditStore, service.audit);
  assert.equal(service.paymentGatewayService.outboxStore, service.outbox);
});

test('disabled callback runtime exposes no verifier callback store or callback service', () => {
  const service = createRuntimeService({
    env:{ DATABASE_URL:'postgres://example/db', DCIECMS_PAYMENT_GATEWAY_MODE:'disabled' },
    PoolClass:FakePool
  });

  assert.equal(service.paymentGatewayVerifier, null);
  assert.equal(service.paymentCallbackStore, null);
  assert.equal(service.paymentGatewayService, null);
});
