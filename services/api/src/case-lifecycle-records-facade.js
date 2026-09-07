'use strict';

const CASE_LIFECYCLE_RECORDS_METHODS = Object.freeze([
  'disposeCase',
  'closeCase',
  'reopenCase',
  'getCaseRecordControl',
  'assignRetention',
  'archiveCaseRecord',
  'setCaseLegalHold',
  'releaseCaseLegalHold',
  'requestCaseRecordDisposal',
  'approveCaseRecordDisposal',
  'rejectCaseRecordDisposal'
]);

function requireCaseLifecycleRecordsService(instance) {
  const service = instance.caseLifecycleRecords;
  if (!service) throw new TypeError('Case lifecycle and records service is not configured');
  return service;
}

function installCaseLifecycleRecordsFacade(TargetClass) {
  for (const method of CASE_LIFECYCLE_RECORDS_METHODS) {
    if (Object.prototype.hasOwnProperty.call(TargetClass.prototype, method)) {
      throw new TypeError(`Case lifecycle records facade cannot overwrite ${method}`);
    }
    Object.defineProperty(TargetClass.prototype, method, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: function caseLifecycleRecordsDelegate(...args) {
        const service = requireCaseLifecycleRecordsService(this);
        if (typeof service[method] !== 'function') {
          throw new TypeError(`Case lifecycle and records service must expose ${method}()`);
        }
        return service[method](...args);
      }
    });
  }
  return TargetClass;
}

module.exports = {
  CASE_LIFECYCLE_RECORDS_METHODS,
  requireCaseLifecycleRecordsService,
  installCaseLifecycleRecordsFacade
};
