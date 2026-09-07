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
const { createPaymentRuntime } = require('./payment-runtime');
const { PaymentIntegrationService } = require('./payment-integration-service');
const { PaymentWebhookService } = require('./payment-webhook-service');
const { PaymentEventProcessor } = require('./payment-event-processor');
const {
  MemoryPaymentIntegrationRepository,
  MemoryPaymentOutboxStore,
  MemoryTransactionManager
} = require('./memory-payment-integration-repository');

function attachPaymentRuntime(service, paymentRuntime, {
  repository = null,
  auditStore = null,
  outboxStore = null,
  transactionManager = null
} = {}) {
  service.paymentIntegrationMode = paymentRuntime.mode;
  service.paymentProvider = paymentRuntime.provider;
  service.paymentIntegrationRepository = repository;
  service.paymentWebhookService = null;
  service.paymentEventProcessor = null;

  if (!paymentRuntime.enabled) {
    service.paymentIntegration = null;
    return service;
  }

  const paymentIntegration = new PaymentIntegrationService({
    repository,
    provider: paymentRuntime.provider,
    providerCode: paymentRuntime.providerCode,
    auditStore
  });
  const paymentWebhookService = new PaymentWebhookService({
    repository,
    provider: paymentRuntime.provider,
    providerCode: paymentRuntime.providerCode
  });
  const paymentEventProcessor = new PaymentEventProcessor({
    repository,
    auditStore,
    outboxStore,
    transactionManager
  });

  service.paymentIntegration = paymentIntegration;
  service.paymentWebhookService = paymentWebhookService;
  service.paymentEventProcessor = paymentEventProcessor;
  return service;
}

function createRuntimeService({
  env = process.env,
  PoolClass,
  documentStorage = null,
  malwareScanner = null,
  paymentProvider = null
} = {}) {
  const documentRuntime = createDocumentRuntime({
    env,
    storage: documentStorage,
    scanner: malwareScanner
  });
  const paymentRuntime = createPaymentRuntime({
    env,
    provider: paymentProvider
  });
  const connectionString = env.DATABASE_URL && String(env.DATABASE_URL).trim();
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';

  if (!connectionString) {
    if (production && paymentRuntime.enabled) {
      throw new TypeError('Production payment integration requires persistent database configuration');
    }

    const service = new DciecmsService();
    if (documentRuntime.enabled) {
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
    }

    if (paymentRuntime.enabled) {
      const paymentRepository = new MemoryPaymentIntegrationRepository();
      const paymentOutboxStore = new MemoryPaymentOutboxStore();
      const paymentTransactionManager = new MemoryTransactionManager();
      service.outbox = paymentOutboxStore;
      attachPaymentRuntime(service, paymentRuntime, {
        repository: paymentRepository,
        auditStore: service.audit,
        outboxStore: paymentOutboxStore,
        transactionManager: paymentTransactionManager
      });
    } else {
      attachPaymentRuntime(service, paymentRuntime);
    }
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

  if (paymentRuntime.enabled) {
    attachPaymentRuntime(service, paymentRuntime, {
      repository,
      auditStore,
      outboxStore,
      transactionManager: database
    });
  } else {
    attachPaymentRuntime(service, paymentRuntime);
  }

  return createTransactionalService(service, database);
}

module.exports = { createRuntimeService };