'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DciecmsService } = require('../../services/api/src/dciecms-service');
const { JudicialOperationsService } = require('../../services/api/src/judicial-operations-service');
const { JudicialPostgresRepository } = require('../../services/api/src/judicial-postgres-repository');
const { createRuntimeService } = require('../../services/api/src/runtime-service');

test('runtime service uses in-memory implementation when DATABASE_URL is absent', () => {
  const service = createRuntimeService({ env: {}, PoolClass: class UnexpectedPool {} });
  assert.ok(service instanceof DciecmsService);
});

test('runtime service uses judicial PostgreSQL-backed implementation when DATABASE_URL is present', () => {
  class FakePool {
    constructor(options) { this.options = options; }
    async query() { return { rows: [] }; }
    async connect() { throw new Error('not used by constructor'); }
  }
  const service = createRuntimeService({ env: { DATABASE_URL: 'postgres://example/db' }, PoolClass: FakePool });
  assert.ok(service instanceof JudicialOperationsService);
  assert.ok(service.repository instanceof JudicialPostgresRepository);
  assert.equal(service.repository.db.options.connectionString, 'postgres://example/db');
  assert.equal(typeof service.assignCase, 'function');
  assert.equal(typeof service.listMyCases, 'function');
});
