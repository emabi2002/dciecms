'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { createRuntimeService } = require('../../services/api/src/runtime-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const CASE_ID = '22222222-2222-2222-2222-222222222222';
const actor = resolveActorFromClaims({ sub: 'cmag-a', roles: ['CMAG'], court_ids: [COURT_A] });

function lifecycleCase(status = 'DISPOSED') {
  return {
    case_id: CASE_ID,
    case_number: 'POM-CIVIL-2026-000001',
    filing_id: '33333333-3333-3333-3333-333333333333',
    payment_id: '44444444-4444-4444-4444-444444444444',
    court_id: COURT_A,
    case_type_code: 'CIVIL',
    status,
    opened_by_subject: 'reg-mgr-a',
    opened_at: '2026-09-01T00:00:00.000Z',
    assigned_to_subject: 'mag-a',
    assigned_by_subject: 'cmag-a',
    assigned_at: '2026-09-02T00:00:00.000Z',
    disposition_code: 'FINAL_JUDGMENT',
    disposed_by_subject: 'mag-a',
    disposed_at: '2026-09-07T00:00:00.000Z',
    closure_code: status === 'CLOSED' ? 'FINALIZED' : null,
    closed_by_subject: status === 'CLOSED' ? 'cmag-a' : null,
    closed_at: status === 'CLOSED' ? '2026-09-07T01:00:00.000Z' : null,
    reopened_by_subject: null,
    reopened_at: null
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

          if (/SELECT[\s\S]+FROM case_mgmt\.cases WHERE case_id=\$1/i.test(text)) {
            return { rows: [lifecycleCase('DISPOSED')] };
          }

          if (/WITH transitioned AS \([\s\S]+UPDATE case_mgmt\.cases[\s\S]+SET status='CLOSED'/i.test(text)) {
            return { rows: [lifecycleCase('CLOSED')] };
          }

          if (/INSERT INTO audit\.audit_events/i.test(text)) {
            if (failAudit) throw new Error('records audit insert failed');
            return { rows: [] };
          }

          if (/INSERT INTO integration\.outbox_events/i.test(text)) {
            if (failOutbox) throw new Error('records outbox insert failed');
            return {
              rows: [{
                outbox_event_id: 'evt-records-1',
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

          throw new Error(`Unexpected records lifecycle SQL: ${text}`);
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
      throw new Error('Lifecycle business, audit and outbox SQL must not bypass the transaction client');
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

test('case closure commits lifecycle mutation audit and outbox on one physical client', async () => {
  const fixture = poolFixture();
  const service = createService(fixture);

  const closed = await service.closeCase(actor, CASE_ID, {
    closureCode: 'FINALIZED',
    reason: 'Final administrative closure'
  });
  assert.equal(closed.status, 'CLOSED');

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => call.text === 'BEGIN').length, 1);
  assert.equal(calls.filter(call => call.text === 'COMMIT').length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 0);
  assert.equal(calls.filter(call => /SET status='CLOSED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO integration\.outbox_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.target === 'pool' && /INSERT|UPDATE|DELETE/i.test(call.text)).length, 0);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('case closure rolls back completed lifecycle SQL when audit persistence fails', async () => {
  const fixture = poolFixture({ failAudit: true });
  const service = createService(fixture);

  await assert.rejects(
    () => service.closeCase(actor, CASE_ID, { closureCode: 'FINALIZED', reason: 'Final administrative closure' }),
    /records audit insert failed/
  );

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /SET status='CLOSED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO integration\.outbox_events/i.test(call.text)).length, 0);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('case closure rolls back lifecycle and audit work when outbox persistence fails', async () => {
  const fixture = poolFixture({ failOutbox: true });
  const service = createService(fixture);

  await assert.rejects(
    () => service.closeCase(actor, CASE_ID, { closureCode: 'FINALIZED', reason: 'Final administrative closure' }),
    /records outbox insert failed/
  );

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /SET status='CLOSED'/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO integration\.outbox_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});
