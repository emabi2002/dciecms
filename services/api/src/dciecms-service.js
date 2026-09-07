'use strict';

const core = require('./dciecms-service-core');
const { installSecureDocumentFacade } = require('./secure-document-facade');
const { installPaymentIntegrationFacade } = require('./payment-integration-facade');

class DciecmsService extends core.DciecmsService {
  constructor(options = {}) {
    super(options);
    this.secureDocuments = options.secureDocumentService || null;
    this.paymentIntegration = options.paymentIntegrationService || null;
  }
}

installSecureDocumentFacade(DciecmsService);
installPaymentIntegrationFacade(DciecmsService);

module.exports = { ...core, DciecmsService };