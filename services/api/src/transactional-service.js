'use strict';

const MUTATING_SERVICE_METHODS = new Set([
  'createParty',
  'createFilingDraft',
  'registerDocument',
  'submitFiling',
  'validateFiling',
  'returnFiling',
  'rejectFiling',
  'acceptFiling',
  'assessFilingFee',
  'createPayment',
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

function createTransactionalService(service, transactionManager) {
  if (!service) throw new TypeError('createTransactionalService requires a service');
  if (!transactionManager || typeof transactionManager.withTransaction !== 'function') {
    throw new TypeError('createTransactionalService requires a transaction manager');
  }

  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;

      if (typeof property === 'string' && MUTATING_SERVICE_METHODS.has(property)) {
        return (...args) => transactionManager.withTransaction(() => value.apply(target, args));
      }

      return value.bind(target);
    }
  });
}

module.exports = { MUTATING_SERVICE_METHODS, createTransactionalService };
