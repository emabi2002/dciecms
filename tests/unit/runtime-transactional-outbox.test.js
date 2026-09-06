'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { createRuntimeService } = require('../../services/api/src/runtime-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const PAYMENT_ID = '22222222-2222-2222-2222-222222222222';
const actor = resolveActorFromClaims({ sub: 'fin-mgr-a', roles: ['FIN-MGR'], court_ids: [COURT_A] });

function poolFixture({ failOutbox = false } = {}) {
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
          if (/SELECT payment_id.*FROM finance\.payments WHERE payment_id=\$1/is.test(text)) {
            return { rows: [{
              payment_id: PAYMENT_ID, assessment_id: 'a-1', court_id: COURT_A,
              amount_minor: 12000, currency: 'PGK', status: 'PENDING', provider_reference: null,
              created_by_subject: 'fin-a', created_at: '2026-09-06T00:00:00.000Z',
              confirmed_by_subject: null, confirmed_at: null
            }] };
          }
          if (/UPDATE finance\.payments SET status='CONFIRMED'/i.test(text)) {
            return { rows: [{
              payment_id: PAYMENT_ID, assessment_id: 'a-1', court_id: COURT_A,
              amount_minor: 12000, currency: 'PGK', status: 'CONFIRMED', provider_reference: params[1],
              created_by_subject: 'fin-a', created_at: '2026-09-06T00:00:00.000Z',
              confirmed_by_subject: params[2], confirmed_at: params[3]
            }] };
          }
          if (/INSERT INTO audit\.audit_events/i.test(text)) return { rows: [] };
          if (/INSERT INTO integration\.outbox_events/i.test(text)) {
            if (failOutbox) throw new Error('outbox insert failed');
            return { rows: [{
              outbox_event_id: 'evt-1', event_type: params[0], aggregate_type: params[1], aggregate_id: params[2],
              court_id: params[3], actor_subject: params[4], correlation_id: params[5], deduplication_key: params[6],
              payload: JSON.parse(params[7]), headers: JSON.parse(params[8]), status: 'PENDING', attempt_count: 0,
              next_attempt_at: '2026-09-06T00:00:00.000Z', locked_at: null, locked_by: null,
              last_attempt_at: null, last_error: null, created_at: '2026-09-06T00:00:00.000Z', delivered_at: null
            }] };
          }
          throw new Error(`Unexpected client SQL: ${text}`);
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
      throw new Error('Business, audit and outbox SQL must not bypass the transaction client');
    }
  }
  return { PoolClass: FakePool, getInstance: () => instance };
}

test('PostgreSQL runtime commits payment mutation, audit evidence and outbox event on one physical client', async () => {
  const fixture = poolFixture();
  const service = createRuntimeService({ env: { DATABASE_URL: 'postgres://example/db' }, PoolClass: fixture.PoolClass });

  const confirmed = await service.confirmPayment(actor, PAYMENT_ID, 'PGW-1');
  assert.equal(confirmed.status, 'CONFIRMED');

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => call.text === 'BEGIN').length, 1);
  assert.equal(calls.filter(call => call.text === 'COMMIT').length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 0);
  assert.equal(calls.filter(call => /UPDATE finance\.payments SET status='CONFIRMED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO integration\.outbox_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.target === 'pool' && /INSERT|UPDATE|DELETE/i.test(call.text)).length, 0);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('PostgreSQL runtime rolls back business and audit work when the outbox insert fails', async () => {
  const fixture = poolFixture({ failOutbox: true });
  const service = createRuntimeService({ env: { DATABASE_URL: 'postgres://example/db' }, PoolClass: fixture.PoolClass });

  await assert.rejects(() => service.confirmPayment(actor, PAYMENT_ID, 'PGW-1'), /outbox insert failed/);

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /UPDATE finance\.payments SET status='CONFIRMED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO integration\.outbox_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});
