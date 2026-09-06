'use strict';
const { DciecmsService } = require('./dciecms-service');
const { JudicialWorkbenchService } = require('./judicial-workbench-service');
const { JudgmentPostgresRepository } = require('./judgment-postgres-repository');
const { createPostgresPool } = require('./postgres-runtime');

function createRuntimeService({ env = process.env, PoolClass } = {}) {
  const connectionString = env.DATABASE_URL && String(env.DATABASE_URL).trim();
  if (!connectionString) return new DciecmsService();
  const pool = createPostgresPool({ connectionString, PoolClass });
  const repository = new JudgmentPostgresRepository(pool);
  return new JudicialWorkbenchService({ repository });
}

module.exports = { createRuntimeService };
