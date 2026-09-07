'use strict';

const core = require('./persistent-dciecms-service-core');
const { installSecureDocumentFacade } = require('./secure-document-facade');
const { installPaymentCallbackService } = require('./payment-callback-service');

class PersistentDciecmsService extends core.PersistentDciecmsService {
  constructor(options = {}) {
    super(options);
    this.secureDocuments = options.secureDocumentService || null;
  }
}

installSecureDocumentFacade(PersistentDciecmsService);
installPaymentCallbackService(PersistentDciecmsService);

module.exports = { ...core, PersistentDciecmsService };