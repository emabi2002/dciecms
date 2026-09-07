'use strict';

const core = require('./persistent-dciecms-service-core');
const { installSecureDocumentFacade } = require('./secure-document-facade');
const { installPaymentIntegrationFacade } = require('./payment-integration-facade');
const { installCaseLifecycleRecordsFacade } = require('./case-lifecycle-records-facade');
const { installFinanceCompletionFacade } = require('./finance-completion-facade');

class PersistentDciecmsService extends core.PersistentDciecmsService {
  constructor(options = {}) {
    super(options);
    this.secureDocuments = options.secureDocumentService || null;
    this.paymentIntegration = options.paymentIntegrationService || null;
    this.caseLifecycleRecords = options.caseLifecycleRecordsService || null;
    this.financeCompletion = options.financeCompletionService || null;
  }
}

installSecureDocumentFacade(PersistentDciecmsService);
installPaymentIntegrationFacade(PersistentDciecmsService);
installCaseLifecycleRecordsFacade(PersistentDciecmsService);
installFinanceCompletionFacade(PersistentDciecmsService);

module.exports = { ...core, PersistentDciecmsService };
