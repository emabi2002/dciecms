'use strict';

const core = require('./persistent-dciecms-service-core');
const { SecureDocumentService } = require('./secure-document-service');
const { CaseLifecycleRecordsService } = require('./case-lifecycle-records-service');
const { installSecureDocumentFacade } = require('./secure-document-facade');
const { installPaymentIntegrationFacade } = require('./payment-integration-facade');
const { installCaseLifecycleRecordsFacade } = require('./case-lifecycle-records-facade');

class PersistentDciecmsService extends core.PersistentDciecmsService {
  constructor(options = {}) {
    super(options);
    this.secureDocuments = options.secureDocumentService || null;
    this.paymentIntegration = options.paymentIntegrationService || null;
    this.caseLifecycleRecords = options.caseLifecycleRecordsService || new CaseLifecycleRecordsService({
      repository: this.repository,
      auditStore: this.audit,
      outboxStore: this.outbox
    });
  }
}

installSecureDocumentFacade(PersistentDciecmsService);
installPaymentIntegrationFacade(PersistentDciecmsService);
installCaseLifecycleRecordsFacade(PersistentDciecmsService);

module.exports = { ...core, PersistentDciecmsService, SecureDocumentService, CaseLifecycleRecordsService };
