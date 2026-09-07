'use strict';

const core = require('./persistent-dciecms-service-core');
const { installSecureDocumentFacade } = require('./secure-document-facade');
const { installPaymentIntegrationFacade } = require('./payment-integration-facade');

class PersistentDciecmsService extends core.PersistentDciecmsService {
  constructor(options = {}) {
    super(options);
    this.secureDocuments = options.secureDocumentService || null;
    this.paymentIntegration = options.paymentIntegrationService || null;
  }
}

installSecureDocumentFacade(PersistentDciecmsService);
installPaymentIntegrationFacade(PersistentDciecmsService);

module.exports = { ...core, PersistentDciecmsService };