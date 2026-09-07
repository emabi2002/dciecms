'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PaymentGatewayService } = require('../../services/api/src/payment-gateway-service');

const PAYMENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DIGEST = 'a'.repeat(64);

function tx() { return { withTransaction: work => work() }; }

test('successful callback audit and generic outbox evidence exclude provider payment reference and transport secrets', async () => {
  const audit = [];
  const outbox = [];
  const callbackStore = {
    async claim() { return { kind:'NEW', callback:{ callbackId:'cb-1', processingStatus:'PROCESSING' } }; },
    async markApplied() { return { processingStatus:'APPLIED' }; }
  };
  const repository = {
    async confirmPaymentFromVerifiedGateway() {
      return { paymentId:PAYMENT_ID, courtId:'court-1', amountMinor:1000, currency:'PGK', status:'CONFIRMED' };
    }
  };
  const service = new PaymentGatewayService({
    repository,
    callbackStore,
    auditStore:{ async append(event) { audit.push(event); return event; } },
    outboxStore:{ async enqueue(event) { outbox.push(event); return event; } },
    transactionManager:tx()
  });

  await service.processVerifiedCallback({
    verifiedCallback:{
      provider:'BANK',
      eventId:'evt-secret-1',
      eventType:'PAYMENT_SUCCEEDED',
      paymentReference:PAYMENT_ID,
      providerPaymentReference:'gw-sensitive-reference',
      amountMinor:1000,
      currency:'PGK',
      occurredAt:'2026-09-07T03:25:00.000Z',
      rawBody:'raw-secret',
      signature:'signature-secret',
      secret:'merchant-secret'
    },
    payloadDigestSha256:DIGEST,
    receivedAt:'2026-09-07T03:25:01.000Z'
  });

  const evidence = JSON.stringify({ audit, outbox });
  assert.equal(evidence.includes('gw-sensitive-reference'), false);
  assert.equal(evidence.includes('raw-secret'), false);
  assert.equal(evidence.includes('signature-secret'), false);
  assert.equal(evidence.includes('merchant-secret'), false);
  assert.equal(evidence.includes('evt-secret-1'), true);
  assert.equal(evidence.includes(PAYMENT_ID), true);
});

test('payment gateway system actor is not granted ordinary user roles or court scope', () => {
  const { PAYMENT_GATEWAY_SYSTEM_ACTOR } = require('../../services/api/src/payment-gateway-service');
  assert.equal(PAYMENT_GATEWAY_SYSTEM_ACTOR.userId, 'system:payment-gateway');
  assert.deepEqual(PAYMENT_GATEWAY_SYSTEM_ACTOR.roles, ['SYSTEM']);
  assert.deepEqual(PAYMENT_GATEWAY_SYSTEM_ACTOR.courtIds, []);
  assert.deepEqual(PAYMENT_GATEWAY_SYSTEM_ACTOR.explicitGrants, []);
  assert.equal(Object.isFrozen(PAYMENT_GATEWAY_SYSTEM_ACTOR), true);
});
