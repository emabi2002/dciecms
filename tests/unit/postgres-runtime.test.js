'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { requireDatabaseUrl, createPostgresPool } = require('../../services/api/src/postgres-runtime');

class FakePool {
  constructor(options) { this.options = options; }
}

test('requireDatabaseUrl rejects missing DATABASE_URL', () => {
  assert.throws(() => requireDatabaseUrl({}), /DATABASE_URL/i);
});

test('requireDatabaseUrl returns configured PostgreSQL URL', () => {
  const url = 'postgresql://dciecms:secret@db:5432/dciecms';
  assert.equal(requireDatabaseUrl({ DATABASE_URL: url }), url);
});

test('createPostgresPool configures a pg-compatible pool without logging secrets', () => {
  const connectionString = 'postgresql://dciecms:secret@db:5432/dciecms';
  const pool = createPostgresPool({
    connectionString,
    PoolClass: FakePool,
    ssl: false,
    max: 12,
    applicationName: 'dciecms-api-test'
  });
  assert.equal(pool.options.connectionString, connectionString);
  assert.equal(pool.options.max, 12);
  assert.equal(pool.options.application_name, 'dciecms-api-test');
  assert.equal(pool.options.ssl, false);
});

test('createPostgresPool defaults to bounded pool settings', () => {
  const pool = createPostgresPool({ connectionString: 'postgresql://u:p@db/d', PoolClass: FakePool });
  assert.equal(pool.options.max, 10);
  assert.equal(pool.options.idleTimeoutMillis, 30000);
  assert.equal(pool.options.connectionTimeoutMillis, 5000);
});
