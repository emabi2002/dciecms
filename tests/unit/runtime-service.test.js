'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DciecmsService } = require('../../services/api/src/dciecms-service');
const { JudicialWorkbenchService } = require('../../services/api/src/judicial-workbench-service');
const { FinanceOperationsService } = require('../../services/api/src/finance-operations-service');
const { FinanceOperationsPostgresRepository } = require('../../services/api/src/finance-operations-postgres-repository');
const { createRuntimeService } = require('../../services/api/src/runtime-service');

test('runtime service uses in-memory implementation when DATABASE_URL is absent', () => {
  const service = createRuntimeService({ env: {}, PoolClass: class UnexpectedPool {} });
  assert.ok(service instanceof DciecmsService);
});

test('runtime service layers R3 finance operations over the existing Judicial Workbench when DATABASE_URL is present', () => {
  class FakePool {
    constructor(options) { this.options = options; }
    async query() { return { rows: [] }; }
    async connect() { throw new Error('not used by constructor'); }
  }
  const service = createRuntimeService({ env: { DATABASE_URL: 'postgres://example/db' }, PoolClass: FakePool });
  assert.ok(service instanceof FinanceOperationsService);
  assert.ok(service instanceof JudicialWorkbenchService);
  assert.ok(service.repository instanceof FinanceOperationsPostgresRepository);
  assert.equal(service.repository.db.options.connectionString, 'postgres://example/db');
  assert.equal(typeof service.assignCase, 'function');
  assert.equal(typeof service.listMyCases, 'function');
  assert.equal(typeof service.createJudgment, 'function');
  assert.equal(typeof service.getJudicialCase, 'function');
  assert.equal(typeof service.getJudicialHearing, 'function');
  assert.equal(typeof service.getJudgment, 'function');
  assert.equal(typeof service.listPendingDecisions, 'function');
  assert.equal(typeof service.listFinanceQueue, 'function');
  assert.equal(typeof service.getPaymentDetail, 'function');
  assert.equal(typeof service.repository.signJudgment, 'function');
  assert.equal(typeof service.repository.listPendingJudgments, 'function');
  assert.equal(typeof service.repository.listFinanceQueue, 'function');
});

test('runtime Supabase test profile maps repository SQL into dciecms_test', async () => {
  class FakePool {
    constructor(options) { this.options = options; this.lastSql = null; }
    async query(text) { this.lastSql = text; return { rows: [] }; }
    async connect() { throw new Error('not used'); }
  }
  const service = createRuntimeService({
    env: { DATABASE_URL: 'postgres://example/db', DCIECMS_DB_PROFILE: 'supabase_test' },
    PoolClass: FakePool
  });
  await service.repository.getCase('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.match(service.repository.db.lastSql, /FROM dciecms_test\.cases/);
});
