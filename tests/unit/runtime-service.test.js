'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DciecmsService } = require('../../services/api/src/dciecms-service');
const { JudicialWorkbenchService } = require('../../services/api/src/judicial-workbench-service');
const { JudgmentPostgresRepository } = require('../../services/api/src/judgment-postgres-repository');
const { createRuntimeService } = require('../../services/api/src/runtime-service');

test('runtime service uses in-memory implementation when DATABASE_URL is absent', () => {
  const service = createRuntimeService({ env: {}, PoolClass: class UnexpectedPool {} });
  assert.ok(service instanceof DciecmsService);
});

test('runtime service uses Judicial Workbench with judgment-capable PostgreSQL repository when DATABASE_URL is present', () => {
  class FakePool {
    constructor(options) { this.options = options; }
    async query() { return { rows: [] }; }
    async connect() { throw new Error('not used by constructor'); }
  }
  const service = createRuntimeService({ env: { DATABASE_URL: 'postgres://example/db' }, PoolClass: FakePool });
  assert.ok(service instanceof JudicialWorkbenchService);
  assert.ok(service.repository instanceof JudgmentPostgresRepository);
  assert.equal(service.repository.db.options.connectionString, 'postgres://example/db');
  assert.equal(typeof service.assignCase, 'function');
  assert.equal(typeof service.listMyCases, 'function');
  assert.equal(typeof service.createJudgment, 'function');
  assert.equal(typeof service.getJudicialCase, 'function');
  assert.equal(typeof service.getJudicialHearing, 'function');
  assert.equal(typeof service.getJudgment, 'function');
  assert.equal(typeof service.listPendingDecisions, 'function');
  assert.equal(typeof service.repository.signJudgment, 'function');
  assert.equal(typeof service.repository.listPendingJudgments, 'function');
});
