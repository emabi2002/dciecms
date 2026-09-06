'use strict';
const { DciecmsService } = require('./dciecms-service');
const { JudicialWorkbenchService } = require('./judicial-workbench-service');
const { JudgmentPostgresRepository } = require('./judgment-postgres-repository');
const { PostgresAuditStore } = require('./postgres-audit-store');
const { PostgresTransactionManager } = require('./postgres-transaction-manager');
const { createTransactionalService } = require('./transactional-service');
const { createPostgresPool } = require('./postgres-runtime');
const { createMappedDatabase } = require('./postgres-schema-mapping');

function createRuntimeService({ env = process.env, PoolClass } = {}) {
  const connectionString = env.DATABASE_URL && String(env.DATABASE_URL).trim();
  if (!connectionString) return new DciecmsService();

  const pool = createPostgresPool({ connectionString, PoolClass });
  const mappedDatabase = createMappedDatabase(pool, String(env.DCIECMS_DB_PROFILE || 'logical').trim());
  const database = new PostgresTransactionManager(mappedDatabase);
  const repository = new JudgmentPostgresRepository(database);
  const auditStore = new PostgresAuditStore(database);
  const service = new JudicialWorkbenchService({ repository, auditStore });

  return createTransactionalService(service, database);
}

module.exports = { createRuntimeService };