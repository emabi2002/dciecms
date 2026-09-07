'use strict';

const FINANCE_COMPLETION_METHODS = Object.freeze([
  'createFeeSchedule','listFeeSchedules','getFeeSchedule','activateFeeSchedule','retireFeeSchedule',
  'requestPaymentAdjustment','getPaymentAdjustment','approvePaymentAdjustment','rejectPaymentAdjustment',
  'requestRefund','getRefund','approveRefund','rejectRefund','completeRefund',
  'rejectReconciliation','listReconciliationExceptions'
]);

function requireFinanceCompletionService(instance) {
  const service = instance.financeCompletion;
  if (!service) throw new TypeError('Finance completion service is not configured');
  return service;
}

function installFinanceCompletionFacade(TargetClass) {
  for (const method of FINANCE_COMPLETION_METHODS) {
    if (Object.prototype.hasOwnProperty.call(TargetClass.prototype, method)) {
      throw new TypeError(`Finance completion facade cannot overwrite ${method}`);
    }
    Object.defineProperty(TargetClass.prototype, method, {
      configurable:false, enumerable:false, writable:false,
      value:function financeCompletionDelegate(...args) {
        const service = requireFinanceCompletionService(this);
        if (typeof service[method] !== 'function') throw new TypeError(`Finance completion service must expose ${method}()`);
        return service[method](...args);
      }
    });
  }
  return TargetClass;
}

module.exports = { FINANCE_COMPLETION_METHODS, requireFinanceCompletionService, installFinanceCompletionFacade };
