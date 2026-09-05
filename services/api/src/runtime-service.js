'use strict';
const { DciecmsService } = require('./dciecms-service');
const { PersistentDciecmsService } = require('./persistent-dciecms-service');
const { PostgresRepository } = require('./postgres-repository');
const { createPostgresPool } = require('./postgres-runtime');

function createRuntimeService({ env = process.env, PoolClass } = {}) {
  const connectionString = env.DATABASE_URL && String(env.DATABASE_URL).trim();
  if (!connectionString) return new DciecmsService();
  const pool = createPostgresPool({ connectionString, PoolClass });
  const repository = new PostgresRepository(pool);
  return new PersistentDciecmsService({ repository });
}

module.exports = { createRuntimeService };
