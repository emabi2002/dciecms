'use strict';

const core = require('./dciecms-service-core');
const { installSecureDocumentFacade } = require('./secure-document-facade');

class DciecmsService extends core.DciecmsService {
  constructor(options = {}) {
    super(options);
    this.secureDocuments = options.secureDocumentService || null;
  }
}

installSecureDocumentFacade(DciecmsService);

module.exports = { ...core, DciecmsService };
