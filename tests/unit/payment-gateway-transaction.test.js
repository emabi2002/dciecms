'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PaymentGatewayService } = require('../../services/api/src/payment-gateway-service');

const PAYMENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CALLBACK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DIGEST = 'a'.repeat(64);

function callback() {
  return {
    provider:'BANK', eventId:'evt-tx-1', eventType:'PAYMENT_SUCCEEDED',
    paymentReference:PAYMENT_ID, providerPaymentReference:'gw-tx-1',
    amountMinor:2500, currency:'PGK', occurredAt:'2026-09-07T03:20:00.000Z'
  };
}

class RecordingTransactionManager {
  constructor() { this.active = false; this.events = []; }
  async withTransaction(work) {
    this.events.push('BEGIN');
    this.active = true;
    try {
      const result = await work();
      this.events.push('COMMIT');
      return result;
    } catch (error) {
      this.events.push('ROLLBACK');
      throw error;
    } finally {
      this.active = false;
    }
  }
}

function build({ auditError = null, outboxError = null } = {}) {
  const tx = new RecordingTransactionManager();
  const calls = [];
  const assertActive = name => {
    assert.equal(tx.active, true, `${name} must run inside the outer transaction`);
    calls.push(name);
  };
  const callbackStore = {
    async claim() {
      assertActive('claim');
      return { kind:'NEW', callback:{ callbackId:CALLBACK_ID, processingStatus:'PROCESSING' } };
    },
    async markApplied() {
      assertActive('markApplied');
      return { callbackId:CALLBACK_ID, processingStatus:'APPLIED', paymentId:PAYMENT_ID, outcomeCode:'PAYMENT_CONFIRMED' };
    },
    async markIgnored() {
      assertActive('markIgnored');
      return { callbackId:CALLBACK_ID, processingStatus:'IGNORED', outcomeCode:'GATEWAY_PAYMENT_FAILED' };
    },
    async markRejected() {
      assertActive('markRejected');
      return { callbackId:CALLBACK_ID, processingStatus:'REJECTED', failureCode:'PAYMENT_EVIDENCE_MISMATCH' };
    }
  };
  const repository = {
    async confirmPaymentFromVerifiedGateway() {
      assertActive('confirmPayment');
      return {
        paymentId:PAYMENT_ID, courtId:'11111111-1111-1111-1111-111111111111',
        amountMinor:2500, currency:'PGK', status:'CONFIRMED'
      };
    }
  };
  const auditStore = {
    async append() {
      assertActive('audit');
      if (auditError) throw auditError;
      return {};
    }
  };
  const outboxStore = {
    async enqueue() {
      assertActive('outbox');
      if (outboxError) throw outboxError;
      return {};
    }
  };
  return {
    tx,
    calls,
    service:new PaymentGatewayService({ repository, callbackStore, auditStore, outboxStore, transactionManager:tx })
  };
}

test('callback claim payment mutation completion audit and outbox all execute inside one outer transaction', async () => {
  const f = build();
  await f.service.processVerifiedCallback({
    verifiedCallback:callback(), payloadDigestSha256:DIGEST, receivedAt:'2026-09-07T03:20:01.000Z'
  });
  assert.deepEqual(f.calls, ['claim','confirmPayment','markApplied','audit','outbox']);
  assert.deepEqual(f.tx.events, ['BEGIN','COMMIT']);
});

test('audit failure aborts the callback transaction before outbox publication', async () => {
  const f = build({ auditError:new Error('audit insert failed') });
  await assert.rejects(
    () => f.service.processVerifiedCallback({ verifiedCallback:callback(), payloadDigestSha256:DIGEST }),
    /audit insert failed/
  );
  assert.deepEqual(f.calls, ['claim','confirmPayment','markApplied','audit']);
  assert.deepEqual(f.tx.events, ['BEGIN','ROLLBACK']);
});

test('outbox failure aborts the whole callback transaction after payment audit work', async () => {
  const f = build({ outboxError:new Error('outbox insert failed') });
  await assert.rejects(
    () => f.service.processVerifiedCallback({ verifiedCallback:callback(), payloadDigestSha256:DIGEST }),
    /outbox insert failed/
  );
  assert.deepEqual(f.calls, ['claim','confirmPayment','markApplied','audit','outbox']);
  assert.deepEqual(f.tx.events, ['BEGIN','ROLLBACK']);
});
