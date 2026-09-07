'use strict';

const SECURE_DOCUMENT_METHODS = Object.freeze([
  'initiateDocumentUpload',
  'finalizeDocumentUpload',
  'authorizeDocumentDownload',
  'changeDocumentClassification',
  'createReplacementDocument',
  'supersedeDocument',
  'withdrawDocument',
  'retryDocumentScan'
]);

function requireSecureDocumentService(instance) {
  const service = instance.secureDocuments;
  if (!service) throw new TypeError('Secure document pipeline is not configured');
  return service;
}

function installSecureDocumentFacade(TargetClass) {
  for (const method of SECURE_DOCUMENT_METHODS) {
    if (Object.prototype.hasOwnProperty.call(TargetClass.prototype, method)) {
      throw new TypeError(`Secure document facade cannot overwrite ${method}`);
    }
    Object.defineProperty(TargetClass.prototype, method, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: function secureDocumentDelegate(...args) {
        const service = requireSecureDocumentService(this);
        if (typeof service[method] !== 'function') {
          throw new TypeError(`Secure document pipeline must expose ${method}()`);
        }
        return service[method](...args);
      }
    });
  }
  return TargetClass;
}

module.exports = {
  SECURE_DOCUMENT_METHODS,
  requireSecureDocumentService,
  installSecureDocumentFacade
};
