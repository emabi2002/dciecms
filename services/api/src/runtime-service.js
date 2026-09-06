'use strict';
const { DciecmsService } = require('./dciecms-service');
const { JudicialOperationsService } = require('./judicial-operations-service');
const { JudicialPostgresRepository } = require('./judicial-postgres-repository');
const { createPostgresPool } = require('./postgres-runtime');

function createRuntimeService({ env = process.env, PoolClass } = {}) {
  const connectionString = env.DATABASE_URL && String(env.DATABASE_URL).trim();
  if (!connectionString) return new DciecmsService();
  const pool = createPostgresPool({ connectionString, PoolClass });
  const repository = new JudicialPostgresRepository(pool);
  return new JudicialOperationsService({ repository });
}

module.exports = { createRuntimeService };
