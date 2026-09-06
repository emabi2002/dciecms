'use strict';
const { DciecmsService } = require('./dciecms-service');
const { JudicialWorkbenchService } = require('./judicial-workbench-service');
const { JudgmentPostgresRepository } = require('./judgment-postgres-repository');
const { PostgresAuditStore } = require('./postgres-audit-store');
const { createPostgresPool } = require('./postgres-runtime');
const { createMappedDatabase } = require('./postgres-schema-mapping');

function createRuntimeService({ env = process.env, PoolClass } = {}) {
  const connectionString = env.DATABASE_URL && String(env.DATABASE_URL).trim();
  if (!connectionString) return new DciecmsService();
  const pool = createPostgresPool({ connectionString, PoolClass });
  const database = createMappedDatabase(pool, String(env.DCIECMS_DB_PROFILE || 'logical').trim());
  const repository = new JudgmentPostgresRepository(database);
  const auditStore = new PostgresAuditStore(database);
  return new JudicialWorkbenchService({ repository, auditStore });
}

module.exports = { createRuntimeService };
