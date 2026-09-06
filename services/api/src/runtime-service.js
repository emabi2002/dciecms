'use strict';
const { DciecmsService } = require('./dciecms-service');
const { FinanceOperationsService } = require('./finance-operations-service');
const { FinanceOperationsPostgresRepository } = require('./finance-operations-postgres-repository');
const { createPostgresPool } = require('./postgres-runtime');
const { createMappedDatabase } = require('./postgres-schema-mapping');

function createRuntimeService({ env = process.env, PoolClass } = {}) {
  const connectionString = env.DATABASE_URL && String(env.DATABASE_URL).trim();
  if (!connectionString) return new DciecmsService();
  const pool = createPostgresPool({ connectionString, PoolClass });
  const database = createMappedDatabase(pool, String(env.DCIECMS_DB_PROFILE || 'logical').trim());
  const repository = new FinanceOperationsPostgresRepository(database);
  return new FinanceOperationsService({ repository });
}

module.exports = { createRuntimeService };
