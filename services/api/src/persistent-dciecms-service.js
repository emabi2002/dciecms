'use strict';

const { randomUUID } = require('node:crypto');
const core = require('./persistent-dciecms-service-core');
const { AccessDeniedError } = require('../../../packages/rbac');
const { ConflictError, NotFoundError, ValidationError } = require('./dciecms-service');
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

  async assessFilingFee(actor, filingId, input = {}) {
    const filing = await this._filingForAccess(actor, filingId, 'finance.assess');
    if (filing.status !== 'ACCEPTED') throw new ConflictError(`Fee assessment requires ACCEPTED filing, got ${filing.status}`);

    let feeScheduleId = null;
    let amountMinor;
    let currency;

    if (input.feeScheduleId) {
      feeScheduleId = String(input.feeScheduleId).trim();
      if (!feeScheduleId) throw new ValidationError('feeScheduleId is required when supplied');
      if (typeof this.repository.getFeeSchedule !== 'function') throw new TypeError('repository must expose getFeeSchedule()');
      const schedule = await this.repository.getFeeSchedule(feeScheduleId);
      if (!schedule) throw new NotFoundError('Fee schedule not found');
      if (schedule.courtId !== null && schedule.courtId !== filing.courtId) throw new AccessDeniedError('Fee schedule is outside filing court scope');
      if (schedule.status !== 'ACTIVE') throw new ConflictError(`Fee schedule must be ACTIVE, got ${schedule.status}`);
      if (String(schedule.caseTypeCode || '').toUpperCase() !== String(filing.caseTypeCode || '').toUpperCase()) {
        throw new ConflictError('Fee schedule does not apply to the filing case type');
      }
      const today = new Date().toISOString().slice(0, 10);
      if (schedule.effectiveFrom && schedule.effectiveFrom > today) throw new ConflictError('Fee schedule is not yet effective');
      if (schedule.effectiveTo && schedule.effectiveTo < today) throw new ConflictError('Fee schedule has expired');
      amountMinor = Number(schedule.amountMinor);
      currency = String(schedule.currency || '').trim().toUpperCase();
    } else {
      amountMinor = input.amountMinor;
      currency = String(input.currency || 'PGK').trim().toUpperCase();
    }

    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new ValidationError('amountMinor must be a positive integer');
    if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError('currency must be a 3-letter code');

    const assessment = await this.repository.createFeeAssessment({
      assessmentId: randomUUID(), filingId, courtId: filing.courtId, feeScheduleId,
      amountMinor, currency, actorSubject: actor.userId, at: new Date().toISOString()
    });
    await this._audit(actor, 'finance.fee.assess', 'fee_assessment', assessment.assessmentId, {
      courtId: filing.courtId, filingId, feeScheduleId, amountMinor, currency
    });
    return assessment;
  }
}

installSecureDocumentFacade(PersistentDciecmsService);
installPaymentIntegrationFacade(PersistentDciecmsService);
installCaseLifecycleRecordsFacade(PersistentDciecmsService);
installFinanceCompletionFacade(PersistentDciecmsService);

module.exports = { ...core, PersistentDciecmsService };
