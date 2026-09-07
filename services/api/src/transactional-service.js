'use strict';

const MUTATING_SERVICE_METHODS = Object.freeze([
  'createParty',
  'createFilingDraft',
  'registerDocument',
  'initiateDocumentUpload',
  'finalizeDocumentUpload',
  'authorizeDocumentDownload',
  'changeDocumentClassification',
  'createReplacementDocument',
  'supersedeDocument',
  'withdrawDocument',
  'retryDocumentScan',
  'submitFiling',
  'validateFiling',
  'returnFiling',
  'rejectFiling',
  'acceptFiling',
  'assessFilingFee',
  'createPayment',
  'createPaymentSession',
  'confirmPayment',
  'issueReceipt',
  'createReconciliation',
  'certifyReconciliation',
  'openCase',
  'assignCase',
  'scheduleHearing',
  'adjournHearing',
  'startHearing',
  'recordAppearance',
  'recordProceeding',
  'completeHearing',
  'createJudgment',
  'updateJudgmentDraft',
  'reviewJudgment',
  'signJudgment',
  'issueJudgment'
]);
const MUTATING_SERVICE_METHOD_SET = new Set(MUTATING_SERVICE_METHODS);

function createTransactionalService(service, transactionManager) {
  if (!service) throw new TypeError('createTransactionalService requires a service');
  if (!transactionManager || typeof transactionManager.withTransaction !== 'function') {
    throw new TypeError('createTransactionalService requires a transaction manager');
  }

  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;

      if (typeof property === 'string' && MUTATING_SERVICE_METHOD_SET.has(property)) {
        return (...args) => transactionManager.withTransaction(() => value.apply(target, args));
      }

      return value.bind(target);
    }
  });
}

module.exports = { MUTATING_SERVICE_METHODS, createTransactionalService };