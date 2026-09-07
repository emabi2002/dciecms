'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { createRuntimeService } = require('../../services/api/src/runtime-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const PAYMENT_ID = '22222222-2222-2222-2222-222222222222';
const REFUND_ID = '33333333-3333-3333-3333-333333333333';
const actor = resolveActorFromClaims({ sub: 'fin-mgr-a', roles: ['FIN-MGR'], court_ids: [COURT_A] });

function refundRow(status = 'REQUESTED') {
  return {
    refund_request_id: REFUND_ID,
    payment_id: PAYMENT_ID,
    court_id: COURT_A,
    amount_minor: 500,
    currency: 'PGK',
    reason: 'Duplicate payment',
    status,
    requested_by_subject: 'fin-a',
    requested_at: '2026-09-07T00:00:00.000Z',
    decided_by_subject: status === 'APPROVED' ? 'fin-mgr-a' : null,
    decided_at: status === 'APPROVED' ? '2026-09-07T01:00:00.000Z' : null,
    decision_reason: status === 'APPROVED' ? 'Verified duplicate payment' : null,
    provider_refund_reference: null,
    completed_by_subject: null,
    completed_at: null
  };
}

function poolFixture({ failAudit = false, failOutbox = false } = {}) {
  let instance = null;

  class FakePool {
    constructor(options) {
      this.options = options;
      this.calls = [];
      instance = this;
      this.client = {
        query: async (text, params = []) => {
          this.calls.push({ target: 'client', text, params });
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };

          if (/^\s*SELECT[\s\S]+FROM finance\.refund_requests WHERE refund_request_id=\$1/i.test(text)) {
            return { rows: [refundRow('REQUESTED')] };
          }

          if (/WITH request AS MATERIALIZED[\s\S]+UPDATE finance\.refund_requests rr SET status='APPROVED'/i.test(text)) {
            return { rows: [refundRow('APPROVED')] };
          }

          if (/INSERT INTO audit\.audit_events/i.test(text)) {
            if (failAudit) throw new Error('finance audit insert failed');
            return { rows: [] };
          }

          if (/INSERT INTO integration\.outbox_events/i.test(text)) {
            if (failOutbox) throw new Error('finance outbox insert failed');
            return {
              rows: [{
                outbox_event_id: 'evt-finance-1',
                event_type: params[0],
                aggregate_type: params[1],
                aggregate_id: params[2],
                court_id: params[3],
                actor_subject: params[4],
                correlation_id: params[5],
                deduplication_key: params[6],
                payload: JSON.parse(params[7]),
                headers: JSON.parse(params[8]),
                status: 'PENDING',
                attempt_count: 0,
                next_attempt_at: '2026-09-07T01:00:00.000Z',
                locked_at: null,
                locked_by: null,
                last_attempt_at: null,
                last_error: null,
                created_at: '2026-09-07T01:00:00.000Z',
                delivered_at: null
              }]
            };
          }

          throw new Error(`Unexpected finance SQL: ${text}`);
        },
        release: () => this.calls.push({ target: 'client', text: 'RELEASE', params: [] })
      };
    }

    async connect() {
      this.calls.push({ target: 'pool', text: 'CONNECT', params: [] });
      return this.client;
    }

    async query(text) {
      this.calls.push({ target: 'pool', text, params: [] });
      throw new Error('Finance business, audit and outbox SQL must not bypass the transaction client');
    }
  }

  return { PoolClass: FakePool, getInstance: () => instance };
}

function createService(fixture) {
  return createRuntimeService({
    env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://example/db' },
    PoolClass: fixture.PoolClass
  });
}

test('refund approval commits mutation, audit and outbox on one physical client', async () => {
  const fixture = poolFixture();
  const service = createService(fixture);

  const approved = await service.approveRefund(actor, REFUND_ID, {
    decisionReason: 'Verified duplicate payment'
  });
  assert.equal(approved.status, 'APPROVED');

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => call.text === 'BEGIN').length, 1);
  assert.equal(calls.filter(call => call.text === 'COMMIT').length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 0);
  assert.equal(calls.filter(call => /UPDATE finance\.refund_requests rr SET status='APPROVED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO integration\.outbox_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.target === 'pool' && /INSERT|UPDATE|DELETE/i.test(call.text)).length, 0);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('refund approval rolls back business state when audit persistence fails', async () => {
  const fixture = poolFixture({ failAudit: true });
  const service = createService(fixture);

  await assert.rejects(
    () => service.approveRefund(actor, REFUND_ID, { decisionReason: 'Verified duplicate payment' }),
    /finance audit insert failed/
  );

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /UPDATE finance\.refund_requests rr SET status='APPROVED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO integration\.outbox_events/i.test(call.text)).length, 0);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('refund approval rolls back business and audit work when outbox persistence fails', async () => {
  const fixture = poolFixture({ failOutbox: true });
  const service = createService(fixture);

  await assert.rejects(
    () => service.approveRefund(actor, REFUND_ID, { decisionReason: 'Verified duplicate payment' }),
    /finance outbox insert failed/
  );

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /UPDATE finance\.refund_requests rr SET status='APPROVED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO integration\.outbox_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});
