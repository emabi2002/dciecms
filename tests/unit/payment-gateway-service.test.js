'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PaymentGatewayService,
  PAYMENT_GATEWAY_SYSTEM_ACTOR
} = require('../../services/api/src/payment-gateway-service');

const PAYMENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CALLBACK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DIGEST = 'a'.repeat(64);

function callback(overrides = {}) {
  return {
    provider:'BANK',
    eventId:'evt-1',
    eventType:'PAYMENT_SUCCEEDED',
    paymentReference:PAYMENT_ID,
    providerPaymentReference:'gw-pay-1',
    amountMinor:12500,
    currency:'PGK',
    occurredAt:'2026-09-07T03:15:00.000Z',
    ...overrides
  };
}

function storedCallback(overrides = {}) {
  return {
    callbackId:CALLBACK_ID,
    provider:'BANK',
    eventId:'evt-1',
    eventType:'PAYMENT_SUCCEEDED',
    paymentReference:PAYMENT_ID,
    providerPaymentReference:'gw-pay-1',
    amountMinor:12500,
    currency:'PGK',
    occurredAt:'2026-09-07T03:15:00.000Z',
    processingStatus:'PROCESSING',
    outcomeCode:null,
    paymentId:null,
    payloadDigestSha256:DIGEST,
    failureCode:null,
    ...overrides
  };
}

class FakeTransactionManager {
  constructor() { this.calls = 0; this.active = false; }
  async withTransaction(work) {
    this.calls += 1;
    this.active = true;
    try { return await work(); } finally { this.active = false; }
  }
}

function fixture({ claimResult, confirmError = null, auditError = null, outboxError = null } = {}) {
  const transactionManager = new FakeTransactionManager();
  const callbackStore = {
    claims:[], applied:[], ignored:[], rejected:[],
    async claim(value, options) {
      this.claims.push({ value, options, active:transactionManager.active });
      return claimResult || { kind:'NEW', callback:storedCallback() };
    },
    async markApplied(value) {
      this.applied.push({ ...value, active:transactionManager.active });
      return storedCallback({ processingStatus:'APPLIED', outcomeCode:value.outcomeCode, paymentId:value.paymentId });
    },
    async markIgnored(value) {
      this.ignored.push({ ...value, active:transactionManager.active });
      return storedCallback({ eventType:'PAYMENT_FAILED', processingStatus:'IGNORED', outcomeCode:value.outcomeCode });
    },
    async markRejected(value) {
      this.rejected.push({ ...value, active:transactionManager.active });
      return storedCallback({ processingStatus:'REJECTED', failureCode:value.failureCode });
    }
  };
  const repository = {
    confirms:[],
    async confirmPaymentFromVerifiedGateway(value) {
      this.confirms.push({ ...value, active:transactionManager.active });
      if (confirmError) throw confirmError;
      return Object.freeze({
        paymentId:PAYMENT_ID,
        assessmentId:'assessment-1',
        courtId:'11111111-1111-1111-1111-111111111111',
        amountMinor:12500,
        currency:'PGK',
        status:'CONFIRMED',
        providerReference:'gw-pay-1',
        confirmedBy:PAYMENT_GATEWAY_SYSTEM_ACTOR.userId,
        confirmedAt:'2026-09-07T03:15:00.000Z'
      });
    }
  };
  const auditStore = {
    events:[],
    async append(event) {
      this.events.push({ ...event, active:transactionManager.active });
      if (auditError) throw auditError;
      return Object.freeze(event);
    }
  };
  const outboxStore = {
    events:[],
    async enqueue(event) {
      this.events.push({ ...event, active:transactionManager.active });
      if (outboxError) throw outboxError;
      return Object.freeze(event);
    }
  };
  const service = new PaymentGatewayService({ repository, callbackStore, auditStore, outboxStore, transactionManager });
  return { service, repository, callbackStore, auditStore, outboxStore, transactionManager };
}

test('successful verified callback confirms payment, completes inbox, audits and enqueues one provider-neutral event', async () => {
  const f = fixture();
  const result = await f.service.processVerifiedCallback({
    verifiedCallback:callback(),
    payloadDigestSha256:DIGEST,
    receivedAt:'2026-09-07T03:15:01.000Z'
  });

  assert.equal(result.status, 'APPLIED');
  assert.equal(result.replay, false);
  assert.equal(result.paymentId, PAYMENT_ID);
  assert.equal(f.transactionManager.calls, 1);
  assert.equal(f.repository.confirms.length, 1);
  assert.equal(f.callbackStore.applied.length, 1);
  assert.equal(f.auditStore.events.length, 1);
  assert.equal(f.auditStore.events[0].action, 'payment.gateway.confirmed');
  assert.equal(f.outboxStore.events.length, 1);
  assert.equal(f.outboxStore.events[0].eventType, 'payment.confirmed');
  assert.equal(f.outboxStore.events[0].deduplicationKey, `${PAYMENT_ID}:payment.confirmed`);
  assert.deepEqual(f.outboxStore.events[0].payload, {
    paymentId:PAYMENT_ID,
    courtId:'11111111-1111-1111-1111-111111111111',
    status:'CONFIRMED',
    amountMinor:12500,
    currency:'PGK'
  });
});

test('APPLIED replay returns canonical result without repeating payment audit or outbox mutations', async () => {
  const f = fixture({ claimResult:{ kind:'REPLAY', callback:storedCallback({
    processingStatus:'APPLIED', outcomeCode:'PAYMENT_CONFIRMED', paymentId:PAYMENT_ID
  }) } });

  const result = await f.service.processVerifiedCallback({
    verifiedCallback:callback(), payloadDigestSha256:DIGEST, receivedAt:'2026-09-07T03:16:00.000Z'
  });

  assert.equal(result.status, 'APPLIED');
  assert.equal(result.replay, true);
  assert.equal(f.repository.confirms.length, 0);
  assert.equal(f.callbackStore.applied.length, 0);
  assert.equal(f.auditStore.events.length, 0);
  assert.equal(f.outboxStore.events.length, 0);
});

test('verified PAYMENT_FAILED callback is durably ignored and never reverses or confirms payment', async () => {
  const failed = callback({ eventType:'PAYMENT_FAILED', amountMinor:0 });
  const f = fixture({ claimResult:{ kind:'NEW', callback:storedCallback({ eventType:'PAYMENT_FAILED', amountMinor:0 }) } });

  const result = await f.service.processVerifiedCallback({
    verifiedCallback:failed, payloadDigestSha256:DIGEST, receivedAt:'2026-09-07T03:16:00.000Z'
  });

  assert.equal(result.status, 'IGNORED');
  assert.equal(result.outcomeCode, 'GATEWAY_PAYMENT_FAILED');
  assert.equal(f.repository.confirms.length, 0);
  assert.equal(f.callbackStore.ignored.length, 1);
  assert.equal(f.auditStore.events[0].action, 'payment.gateway.failed');
  assert.equal(f.outboxStore.events.length, 0);
});

test('verified amount currency or provider-reference mismatch is recorded REJECTED without payment mutation event', async () => {
  for (const code of [
    'PAYMENT_GATEWAY_AMOUNT_MISMATCH',
    'PAYMENT_GATEWAY_CURRENCY_MISMATCH',
    'PAYMENT_GATEWAY_REFERENCE_MISMATCH'
  ]) {
    const error = new Error(code);
    error.code = code;
    const f = fixture({ confirmError:error });

    const result = await f.service.processVerifiedCallback({
      verifiedCallback:callback(), payloadDigestSha256:DIGEST, receivedAt:'2026-09-07T03:17:00.000Z'
    });

    assert.equal(result.status, 'REJECTED');
    assert.equal(result.failureCode, code);
    assert.equal(f.callbackStore.rejected.length, 1);
    assert.equal(f.auditStore.events[0].action, 'payment.gateway.rejected');
    assert.equal(f.outboxStore.events.length, 0);
  }
});

test('replay of terminal ignored or rejected callback performs no new mutations', async () => {
  for (const replayCallback of [
    storedCallback({ processingStatus:'IGNORED', outcomeCode:'GATEWAY_PAYMENT_FAILED' }),
    storedCallback({ processingStatus:'REJECTED', failureCode:'PAYMENT_GATEWAY_AMOUNT_MISMATCH' })
  ]) {
    const f = fixture({ claimResult:{ kind:'REPLAY', callback:replayCallback } });
    const result = await f.service.processVerifiedCallback({
      verifiedCallback:callback(), payloadDigestSha256:DIGEST, receivedAt:'2026-09-07T03:18:00.000Z'
    });
    assert.equal(result.replay, true);
    assert.equal(result.status, replayCallback.processingStatus);
    assert.equal(f.repository.confirms.length, 0);
    assert.equal(f.auditStore.events.length, 0);
    assert.equal(f.outboxStore.events.length, 0);
  }
});

test('non-terminal replay fails closed instead of double-processing an in-progress event', async () => {
  const f = fixture({ claimResult:{ kind:'REPLAY', callback:storedCallback({ processingStatus:'PROCESSING' }) } });
  await assert.rejects(
    () => f.service.processVerifiedCallback({ verifiedCallback:callback(), payloadDigestSha256:DIGEST }),
    error => error && error.code === 'PAYMENT_CALLBACK_STATE_CONFLICT'
  );
  assert.equal(f.repository.confirms.length, 0);
});

test('unexpected payment repository error propagates so the outer transaction can roll back callback claim', async () => {
  const f = fixture({ confirmError:new Error('database unavailable') });
  await assert.rejects(
    () => f.service.processVerifiedCallback({ verifiedCallback:callback(), payloadDigestSha256:DIGEST }),
    /database unavailable/
  );
  assert.equal(f.callbackStore.applied.length, 0);
  assert.equal(f.callbackStore.rejected.length, 0);
  assert.equal(f.auditStore.events.length, 0);
  assert.equal(f.outboxStore.events.length, 0);
});
