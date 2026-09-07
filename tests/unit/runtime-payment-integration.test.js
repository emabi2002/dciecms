'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntimeService } = require('../../services/api/src/runtime-service');
const { PaymentIntegrationService } = require('../../services/api/src/payment-integration-service');
const { PaymentWebhookService } = require('../../services/api/src/payment-webhook-service');
const { PaymentEventProcessor } = require('../../services/api/src/payment-event-processor');
const { DevelopmentPaymentProvider } = require('../../services/api/src/payment-provider');
const { PostgresTransactionManager } = require('../../services/api/src/postgres-transaction-manager');

class ConstructorOnlyPool {
  constructor(options) { this.options = options; }
  async query() { return { rows: [] }; }
  async connect() { throw new Error('not used by constructor'); }
}

test('payment integration is disabled by default and exposes no provider-processing fallback', async () => {
  const service = createRuntimeService({ env: { NODE_ENV: 'production' }, PoolClass: class UnexpectedPool {} });

  assert.equal(service.paymentIntegrationMode, 'disabled');
  assert.equal(service.paymentIntegration, null);
  assert.equal(service.paymentWebhookService, null);
  assert.equal(service.paymentEventProcessor, null);
  assert.equal(typeof service.createPaymentSession, 'function');
  await assert.rejects(
    () => service.createPaymentSession({ userId: 'fin-a', roles: ['FIN'], courtIds: ['COURT-A'] }, 'payment-a', {}),
    /payment integration|disabled|unavailable/i
  );
});

test('production enabled mode fails closed without an approved injected provider', () => {
  assert.throws(
    () => createRuntimeService({
      env: {
        NODE_ENV: 'production',
        DCIECMS_PAYMENT_INTEGRATION_MODE: 'enabled'
      },
      PoolClass: class UnexpectedPool {}
    }),
    /payment provider|required|enabled/i
  );
});

test('development runtime composes one deterministic non-production payment boundary', () => {
  const service = createRuntimeService({
    env: { DCIECMS_PAYMENT_INTEGRATION_MODE: 'development' },
    PoolClass: class UnexpectedPool {}
  });

  assert.equal(service.paymentIntegrationMode, 'development');
  assert.ok(service.paymentProvider instanceof DevelopmentPaymentProvider);
  assert.ok(service.paymentIntegration instanceof PaymentIntegrationService);
  assert.ok(service.paymentWebhookService instanceof PaymentWebhookService);
  assert.ok(service.paymentEventProcessor instanceof PaymentEventProcessor);
  assert.equal(service.paymentIntegration.provider, service.paymentProvider);
  assert.equal(service.paymentWebhookService.provider, service.paymentProvider);
  assert.equal(service.paymentIntegration.repository, service.paymentIntegrationRepository);
  assert.equal(service.paymentWebhookService.repository, service.paymentIntegrationRepository);
  assert.equal(service.paymentEventProcessor.repository, service.paymentIntegrationRepository);
  assert.equal(typeof service.paymentIntegrationRepository.seedPayment, 'function');
  assert.equal(service.paymentProvider.capabilities().developmentOnly, true);
});

test('development payment repository reloads the durable canonical provider event by record id', async () => {
  const service = createRuntimeService({
    env: { DCIECMS_PAYMENT_INTEGRATION_MODE: 'development' },
    PoolClass: class UnexpectedPool {}
  });
  const repository = service.paymentIntegrationRepository;
  const canonical = await repository.recordPaymentProviderEvent({
    providerCode: 'development',
    providerEventId: 'evt-canonical-1',
    providerPaymentReference: 'dev:payment-1',
    paymentId: 'payment-1',
    normalizedEventType: 'PAYMENT_SUCCEEDED',
    amountMinor: 12500,
    currency: 'PGK',
    authenticatedAt: '2026-09-07T01:00:00.000Z',
    receivedAt: '2026-09-07T01:00:01.000Z'
  });

  const reloaded = await repository.getPaymentProviderEvent(canonical.eventRecordId);
  assert.deepEqual(reloaded, canonical);
});

test('persistent runtime shares repository audit outbox and one PostgreSQL transaction manager across payment services', () => {
  const service = createRuntimeService({
    env: {
      DATABASE_URL: 'postgres://example/db',
      DCIECMS_PAYMENT_INTEGRATION_MODE: 'development'
    },
    PoolClass: ConstructorOnlyPool
  });

  assert.equal(service.paymentIntegrationMode, 'development');
  assert.ok(service.paymentIntegration instanceof PaymentIntegrationService);
  assert.ok(service.paymentWebhookService instanceof PaymentWebhookService);
  assert.ok(service.paymentEventProcessor instanceof PaymentEventProcessor);
  assert.ok(service.repository.db instanceof PostgresTransactionManager);
  assert.equal(service.paymentIntegration.repository, service.repository);
  assert.equal(service.paymentIntegration.auditStore, service.audit);
  assert.equal(service.paymentWebhookService.repository, service.repository);
  assert.equal(service.paymentEventProcessor.repository, service.repository);
  assert.equal(service.paymentEventProcessor.auditStore, service.audit);
  assert.equal(service.paymentEventProcessor.outboxStore, service.outbox);
  assert.equal(service.paymentEventProcessor.transactionManager, service.repository.db);
});

test('production rejects development-only provider even when explicitly injected', () => {
  assert.throws(
    () => createRuntimeService({
      env: {
        NODE_ENV: 'production',
        DCIECMS_PAYMENT_INTEGRATION_MODE: 'enabled'
      },
      paymentProvider: new DevelopmentPaymentProvider(),
      PoolClass: class UnexpectedPool {}
    }),
    /development-only|production/i
  );
});
