'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { createRuntimeService } = require('../../services/api/src/runtime-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const actor = resolveActorFromClaims({ sub: 'reg-a', roles: ['REG'], court_ids: [COURT_A] });

function poolFixture({ failAudit = false } = {}) {
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
          if (/INSERT INTO case_mgmt\.parties/i.test(text)) {
            return {
              rows: [{
                party_id: params[0],
                court_id: params[1],
                party_type: params[2],
                display_name: params[3],
                created_at: '2026-09-06T00:00:00.000Z'
              }]
            };
          }
          if (/INSERT INTO audit\.audit_events/i.test(text)) {
            if (failAudit) throw new Error('audit insert failed');
            return { rows: [] };
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
      throw new Error('Business and audit SQL must not bypass the transaction client');
    }
  }

  return { PoolClass: FakePool, getInstance: () => instance };
}

test('PostgreSQL runtime commits business mutation and audit evidence on the same physical client', async () => {
  const fixture = poolFixture();
  const service = createRuntimeService({
    env: { DATABASE_URL: 'postgres://example/db' },
    PoolClass: fixture.PoolClass
  });

  const party = await service.createParty(actor, {
    courtId: COURT_A,
    partyType: 'PERSON',
    displayName: 'Jane Doe'
  });

  assert.equal(party.displayName, 'Jane Doe');
  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => call.text === 'BEGIN').length, 1);
  assert.equal(calls.filter(call => call.text === 'COMMIT').length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 0);
  assert.equal(calls.filter(call => /INSERT INTO case_mgmt\.parties/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.target === 'pool' && /INSERT|UPDATE|DELETE/i.test(call.text)).length, 0);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('PostgreSQL runtime rolls back a completed business SQL mutation when its audit insert fails', async () => {
  const fixture = poolFixture({ failAudit: true });
  const service = createRuntimeService({
    env: { DATABASE_URL: 'postgres://example/db' },
    PoolClass: fixture.PoolClass
  });

  await assert.rejects(
    () => service.createParty(actor, {
      courtId: COURT_A,
      partyType: 'PERSON',
      displayName: 'Jane Doe'
    }),
    /audit insert failed/
  );

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /INSERT INTO case_mgmt\.parties/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});
