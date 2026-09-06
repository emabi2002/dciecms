'use strict';
const { DciecmsService } = require('./dciecms-service');
const { JudicialWorkbenchService } = require('./judicial-workbench-service');
const { JudgmentPostgresRepository } = require('./judgment-postgres-repository');
const { PostgresAuditStore } = require('./postgres-audit-store');
const { PostgresOutboxStore } = require('./postgres-outbox-store');
const { PostgresTransactionManager } = require('./postgres-transaction-manager');
const { createTransactionalService } = require('./transactional-service');
const { createPostgresPool } = require('./postgres-runtime');
const { createMappedDatabase } = require('./postgres-schema-mapping');
const { SecureDocumentService } = require('./secure-document-service');
const {
  createDocumentRuntime,
  MemoryDocumentScanStore,
  MemorySecureDocumentRepository
} = require('./document-runtime');
const { PostgresDocumentScanStore } = require('./postgres-document-scan-store');
const { DocumentScanWorker } = require('./document-scan-worker');

function createRuntimeService({
  env = process.env,
  PoolClass,
  documentStorage = null,
  malwareScanner = null
} = {}) {
  const documentRuntime = createDocumentRuntime({
    env,
    storage: documentStorage,
    scanner: malwareScanner
  });
  const connectionString = env.DATABASE_URL && String(env.DATABASE_URL).trim();

  if (!connectionString) {
    const service = new DciecmsService();
    if (!documentRuntime.enabled) return service;

    const scanStore = new MemoryDocumentScanStore();
    const repository = new MemorySecureDocumentRepository({
      filings: service.filings,
      documents: service.documents,
      scanStore
    });
    const secureDocumentService = new SecureDocumentService({
      repository,
      storage: documentRuntime.storage,
      auditStore: service.audit,
      scanStore
    });
    service.secureDocuments = secureDocumentService;
    service.documentScanStore = scanStore;
    return service;
  }

  const pool = createPostgresPool({ connectionString, PoolClass });
  const mappedDatabase = createMappedDatabase(pool, String(env.DCIECMS_DB_PROFILE || 'logical').trim());
  const database = new PostgresTransactionManager(mappedDatabase);
  const repository = new JudgmentPostgresRepository(database);
  const auditStore = new PostgresAuditStore(database);
  const outboxStore = new PostgresOutboxStore(database);

  let secureDocumentService = null;
  let documentScanStore = null;
  let documentScanWorker = null;
  if (documentRuntime.enabled) {
    documentScanStore = new PostgresDocumentScanStore(database);
    secureDocumentService = new SecureDocumentService({
      repository,
      storage: documentRuntime.storage,
      auditStore,
      scanStore: documentScanStore
    });
    documentScanWorker = new DocumentScanWorker({
      repository,
      scanStore: documentScanStore,
      storage: documentRuntime.storage,
      scanner: documentRuntime.scanner,
      auditStore,
      transactionManager: database,
      workerId: String(env.DCIECMS_DOCUMENT_SCAN_WORKER_ID || 'document-scan-worker').trim()
    });
  }

  const service = new JudicialWorkbenchService({
    repository,
    auditStore,
    outboxStore,
    secureDocumentService
  });
  if (documentScanStore) service.documentScanStore = documentScanStore;
  if (documentScanWorker) service.documentScanWorker = documentScanWorker;

  return createTransactionalService(service, database);
}

module.exports = { createRuntimeService };
