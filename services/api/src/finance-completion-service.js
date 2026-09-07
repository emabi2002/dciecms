'use strict';

const { randomUUID } = require('node:crypto');
const { authorize, AccessDeniedError } = require('../../../packages/rbac');
const { ConflictError, NotFoundError, ValidationError } = require('./dciecms-service');

const ADJUSTMENT_TYPES = new Set(['WAIVER','EXEMPTION','CORRECTION','OTHER_ADJUSTMENT']);
const FEE_SCHEDULE_STATES = new Set(['DRAFT','ACTIVE','RETIRED']);

function normalizeClock(clock) {
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.now === 'function') return () => clock.now();
  return () => new Date();
}

function requireDependency(value, method, label) {
  if (!value || typeof value[method] !== 'function') throw new TypeError(`${label} must expose ${method}()`);
}

function requiredText(value, label, { max = 5000, upper = false } = {}) {
  const text = String(value || '').trim();
  if (!text) throw new ValidationError(`${label} is required`);
  if (text.length > max) throw new ValidationError(`${label} is too long`);
  return upper ? text.toUpperCase() : text;
}

function stableCode(value, label, { max = 80 } = {}) {
  const code = requiredText(value, label, { max, upper: true });
  if (!/^[A-Z0-9][A-Z0-9._-]{0,79}$/.test(code)) throw new ValidationError(`${label} must be a stable code`);
  return code;
}

function currencyCode(value = 'PGK') {
  const code = requiredText(value, 'currency', { max: 3, upper: true });
  if (!/^[A-Z]{3}$/.test(code)) throw new ValidationError('currency must be a 3-letter code');
  return code;
}

function positiveMinor(value, label = 'amountMinor') {
  if (!Number.isInteger(value) || value <= 0) throw new ValidationError(`${label} must be a positive integer`);
  return value;
}

function nonZeroMinor(value, label = 'amountDeltaMinor') {
  if (!Number.isInteger(value) || value === 0) throw new ValidationError(`${label} must be a non-zero integer`);
  return value;
}

function isoDate(value, label) {
  const text = requiredText(value, label, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ValidationError(`${label} must be YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new ValidationError(`${label} must be a valid date`);
  return text;
}

class FinanceCompletionService {
  constructor({ repository, auditStore, outboxStore = null, clock = () => new Date(), uuid = randomUUID } = {}) {
    if (!repository) throw new TypeError('repository is required');
    requireDependency(auditStore, 'append', 'auditStore');
    if (outboxStore) requireDependency(outboxStore, 'enqueue', 'outboxStore');
    if (typeof uuid !== 'function') throw new TypeError('uuid must be a function');
    this.repository = repository;
    this.auditStore = auditStore;
    this.outboxStore = outboxStore;
    this.clock = normalizeClock(clock);
    this.uuid = uuid;
  }

  _now() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('clock returned an invalid date');
    return date.toISOString();
  }

  async _audit(actor, action, resourceType, resourceId, { courtId = null, reason = null, details = {} } = {}) {
    return this.auditStore.append({
      actorUserId: actor.userId,
      effectiveRoles: actor.roles,
      action,
      resourceType,
      resourceId,
      courtId,
      correlationId: actor.correlationId || null,
      reason,
      details
    });
  }

  async _emit(actor, eventType, aggregateType, aggregateId, courtId, payload = {}, occurrenceKey = null) {
    if (!this.outboxStore) return null;
    return this.outboxStore.enqueue({
      eventType,
      aggregateType,
      aggregateId,
      courtId,
      actorSubject: actor.userId,
      correlationId: actor.correlationId || null,
      deduplicationKey: occurrenceKey ? `${aggregateId}:${eventType}:${occurrenceKey}` : `${aggregateId}:${eventType}`,
      payload,
      headers: { schemaVersion: 1 }
    });
  }

  _mapConflict(error, message) {
    const code = String(error?.code || '');
    if (['FEE_SCHEDULE_STATE_CONFLICT','FINANCE_ADJUSTMENT_CONFLICT','FINANCE_REFUND_CONFLICT','RECONCILIATION_STATE_CONFLICT'].includes(code)) {
      const conflict = new ConflictError(message);
      conflict.code = code;
      throw conflict;
    }
    throw error;
  }

  async createFeeSchedule(actor, input = {}) {
    const courtId = requiredText(input.courtId, 'courtId', { max: 160 });
    authorize(actor, 'finance.fee_schedule.manage', { courtId });
    const caseTypeCode = stableCode(input.caseTypeCode, 'caseTypeCode');
    const feeCode = stableCode(input.feeCode, 'feeCode');
    const description = requiredText(input.description, 'description', { max: 255 });
    const amountMinor = positiveMinor(input.amountMinor);
    const currency = currencyCode(input.currency || 'PGK');
    const effectiveFrom = isoDate(input.effectiveFrom, 'effectiveFrom');
    const effectiveTo = input.effectiveTo ? isoDate(input.effectiveTo, 'effectiveTo') : null;
    if (effectiveTo && effectiveTo < effectiveFrom) throw new ValidationError('effectiveTo must not precede effectiveFrom');
    requireDependency(this.repository, 'createFeeSchedule', 'repository');
    const schedule = await this.repository.createFeeSchedule({
      feeScheduleId: this.uuid(), courtId, caseTypeCode, feeCode, description, amountMinor, currency,
      effectiveFrom, effectiveTo, actorSubject: actor.userId, at: this._now()
    });
    await this._audit(actor, 'finance.fee_schedule.create', 'fee_schedule', schedule.feeScheduleId, {
      courtId, details: { caseTypeCode, feeCode, amountMinor, currency, effectiveFrom, effectiveTo }
    });
    return schedule;
  }

  async listFeeSchedules(actor, input = {}) {
    authorize(actor, 'finance.assess', {});
    requireDependency(this.repository, 'listFeeSchedules', 'repository');
    let status = null;
    if (input.status) {
      status = stableCode(input.status, 'status', { max: 20 });
      if (!FEE_SCHEDULE_STATES.has(status)) throw new ValidationError('Unknown fee schedule status');
    }
    return this.repository.listFeeSchedules({ courtIds: actor.courtIds, status });
  }

  async getFeeSchedule(actor, feeScheduleId) {
    const id = requiredText(feeScheduleId, 'feeScheduleId', { max: 160 });
    requireDependency(this.repository, 'getFeeSchedule', 'repository');
    const schedule = await this.repository.getFeeSchedule(id);
    if (!schedule) throw new NotFoundError('Fee schedule not found');
    authorize(actor, 'finance.assess', { courtId: schedule.courtId || actor.courtIds[0] });
    if (schedule.courtId && !actor.courtIds.includes(schedule.courtId)) throw new AccessDeniedError('Fee schedule is outside court scope');
    return schedule;
  }

  async activateFeeSchedule(actor, feeScheduleId) {
    const id = requiredText(feeScheduleId, 'feeScheduleId', { max: 160 });
    requireDependency(this.repository, 'getFeeSchedule', 'repository');
    requireDependency(this.repository, 'activateFeeSchedule', 'repository');
    const schedule = await this.repository.getFeeSchedule(id);
    if (!schedule) throw new NotFoundError('Fee schedule not found');
    authorize(actor, 'finance.fee_schedule.manage', { courtId: schedule.courtId || actor.courtIds[0] });
    try {
      const activated = await this.repository.activateFeeSchedule({ feeScheduleId:id, actorSubject:actor.userId, at:this._now() });
      await this._audit(actor, 'finance.fee_schedule.activate', 'fee_schedule', id, { courtId:schedule.courtId, details:{ status:activated.status } });
      return activated;
    } catch (error) { return this._mapConflict(error, 'Fee schedule activation conflict'); }
  }

  async retireFeeSchedule(actor, feeScheduleId) {
    const id = requiredText(feeScheduleId, 'feeScheduleId', { max: 160 });
    requireDependency(this.repository, 'getFeeSchedule', 'repository');
    requireDependency(this.repository, 'retireFeeSchedule', 'repository');
    const schedule = await this.repository.getFeeSchedule(id);
    if (!schedule) throw new NotFoundError('Fee schedule not found');
    authorize(actor, 'finance.fee_schedule.manage', { courtId: schedule.courtId || actor.courtIds[0] });
    try {
      const retired = await this.repository.retireFeeSchedule({ feeScheduleId:id, actorSubject:actor.userId, at:this._now() });
      await this._audit(actor, 'finance.fee_schedule.retire', 'fee_schedule', id, { courtId:schedule.courtId, details:{ status:retired.status } });
      return retired;
    } catch (error) { return this._mapConflict(error, 'Fee schedule retirement conflict'); }
  }

  async requestPaymentAdjustment(actor, assessmentId, input = {}) {
    const id = requiredText(assessmentId, 'assessmentId', { max: 160 });
    requireDependency(this.repository, 'getFeeAssessment', 'repository');
    requireDependency(this.repository, 'createPaymentAdjustment', 'repository');
    const assessment = await this.repository.getFeeAssessment(id);
    if (!assessment) throw new NotFoundError('Fee assessment not found');
    authorize(actor, 'finance.adjustment.request', { courtId: assessment.courtId });
    if (assessment.status !== 'ASSESSED') throw new ConflictError(`Adjustment requires ASSESSED fee assessment, got ${assessment.status}`);
    const adjustmentType = stableCode(input.adjustmentType, 'adjustmentType');
    if (!ADJUSTMENT_TYPES.has(adjustmentType)) throw new ValidationError('Unknown adjustmentType');
    const amountDeltaMinor = nonZeroMinor(input.amountDeltaMinor);
    if (Number(assessment.amountMinor) + amountDeltaMinor < 0) throw new ValidationError('Adjustment cannot result in a negative assessment amount');
    const reason = requiredText(input.reason, 'reason');
    let paymentId = null;
    if (input.paymentId) {
      paymentId = requiredText(input.paymentId, 'paymentId', { max: 160 });
      requireDependency(this.repository, 'getPayment', 'repository');
      const payment = await this.repository.getPayment(paymentId);
      if (!payment) throw new NotFoundError('Payment not found');
      if (payment.courtId !== assessment.courtId || payment.assessmentId !== assessment.assessmentId) throw new ConflictError('Payment does not belong to the selected fee assessment');
    }
    try {
      const adjustment = await this.repository.createPaymentAdjustment({
        adjustmentId:this.uuid(), assessmentId:id, paymentId, adjustmentType, amountDeltaMinor, reason,
        actorSubject:actor.userId, at:this._now()
      });
      await this._audit(actor, 'finance.adjustment.request', 'payment_adjustment', adjustment.adjustmentId, {
        courtId:assessment.courtId, reason, details:{ assessmentId:id,paymentId,adjustmentType,amountDeltaMinor,resultingAmountMinor:adjustment.resultingAmountMinor,currency:adjustment.currency }
      });
      return adjustment;
    } catch (error) { return this._mapConflict(error, 'Payment adjustment request conflict'); }
  }

  async _adjustmentFor(actor, adjustmentId, permission) {
    const id = requiredText(adjustmentId, 'adjustmentId', { max: 160 });
    requireDependency(this.repository, 'getPaymentAdjustment', 'repository');
    const adjustment = await this.repository.getPaymentAdjustment(id);
    if (!adjustment) throw new NotFoundError('Payment adjustment not found');
    authorize(actor, permission, { courtId: adjustment.courtId });
    return adjustment;
  }

  async getPaymentAdjustment(actor, adjustmentId) {
    return this._adjustmentFor(actor, adjustmentId, 'finance.adjustment.request');
  }

  async approvePaymentAdjustment(actor, adjustmentId, input = {}) {
    const adjustment = await this._adjustmentFor(actor, adjustmentId, 'finance.adjustment.approve');
    if (adjustment.status !== 'REQUESTED') throw new ConflictError(`Adjustment cannot be approved from status ${adjustment.status}`);
    if (adjustment.requestedBy === actor.userId) throw new AccessDeniedError('Segregation of duties: requester cannot approve own adjustment');
    const decisionReason = requiredText(input.decisionReason, 'decisionReason');
    requireDependency(this.repository, 'approvePaymentAdjustment', 'repository');
    try {
      const approved = await this.repository.approvePaymentAdjustment({ adjustmentId:adjustment.adjustmentId, actorSubject:actor.userId, decisionReason, at:this._now() });
      await this._audit(actor, 'finance.adjustment.approve', 'payment_adjustment', adjustment.adjustmentId, {
        courtId:adjustment.courtId, reason:decisionReason, details:{ assessmentId:adjustment.assessmentId,paymentId:adjustment.paymentId,adjustmentType:adjustment.adjustmentType,status:approved.status }
      });
      await this._emit(actor, 'finance.adjustment.approved', 'payment_adjustment', adjustment.adjustmentId, adjustment.courtId, {
        adjustmentId:adjustment.adjustmentId,assessmentId:adjustment.assessmentId,paymentId:adjustment.paymentId,
        courtId:adjustment.courtId,adjustmentType:adjustment.adjustmentType,amountDeltaMinor:adjustment.amountDeltaMinor,
        resultingAmountMinor:adjustment.resultingAmountMinor,currency:adjustment.currency,status:approved.status
      }, approved.decidedAt);
      return approved;
    } catch (error) { return this._mapConflict(error, 'Payment adjustment approval conflict'); }
  }

  async rejectPaymentAdjustment(actor, adjustmentId, input = {}) {
    const adjustment = await this._adjustmentFor(actor, adjustmentId, 'finance.adjustment.approve');
    if (adjustment.status !== 'REQUESTED') throw new ConflictError(`Adjustment cannot be rejected from status ${adjustment.status}`);
    if (adjustment.requestedBy === actor.userId) throw new AccessDeniedError('Segregation of duties: requester cannot reject own adjustment');
    const decisionReason = requiredText(input.decisionReason, 'decisionReason');
    requireDependency(this.repository, 'rejectPaymentAdjustment', 'repository');
    try {
      const rejected = await this.repository.rejectPaymentAdjustment({ adjustmentId:adjustment.adjustmentId, actorSubject:actor.userId, decisionReason, at:this._now() });
      await this._audit(actor, 'finance.adjustment.reject', 'payment_adjustment', adjustment.adjustmentId, { courtId:adjustment.courtId, reason:decisionReason, details:{ status:rejected.status } });
      return rejected;
    } catch (error) { return this._mapConflict(error, 'Payment adjustment rejection conflict'); }
  }

  async requestRefund(actor, paymentId, input = {}) {
    const id = requiredText(paymentId, 'paymentId', { max: 160 });
    requireDependency(this.repository, 'getPayment', 'repository');
    requireDependency(this.repository, 'createRefundRequest', 'repository');
    const payment = await this.repository.getPayment(id);
    if (!payment) throw new NotFoundError('Payment not found');
    authorize(actor, 'finance.refund.request', { courtId: payment.courtId });
    if (payment.status !== 'CONFIRMED') throw new ConflictError(`Refund requires CONFIRMED payment, got ${payment.status}`);
    const amountMinor = positiveMinor(input.amountMinor);
    if (amountMinor > Number(payment.amountMinor)) throw new ValidationError('Refund amount cannot exceed the confirmed payment amount');
    const reason = requiredText(input.reason, 'reason');
    try {
      const refund = await this.repository.createRefundRequest({ refundRequestId:this.uuid(), paymentId:id, amountMinor, reason, actorSubject:actor.userId, at:this._now() });
      await this._audit(actor, 'finance.refund.request', 'refund_request', refund.refundRequestId, { courtId:payment.courtId, reason, details:{ paymentId:id,amountMinor,currency:payment.currency } });
      return refund;
    } catch (error) { return this._mapConflict(error, 'Refund request conflict'); }
  }

  async _refundFor(actor, refundRequestId, permission) {
    const id = requiredText(refundRequestId, 'refundRequestId', { max: 160 });
    requireDependency(this.repository, 'getRefundRequest', 'repository');
    const refund = await this.repository.getRefundRequest(id);
    if (!refund) throw new NotFoundError('Refund request not found');
    authorize(actor, permission, { courtId: refund.courtId });
    return refund;
  }

  async getRefund(actor, refundRequestId) {
    return this._refundFor(actor, refundRequestId, 'finance.refund.view');
  }

  async approveRefund(actor, refundRequestId, input = {}) {
    const refund = await this._refundFor(actor, refundRequestId, 'finance.refund.approve');
    if (refund.status !== 'REQUESTED') throw new ConflictError(`Refund cannot be approved from status ${refund.status}`);
    if (refund.requestedBy === actor.userId) throw new AccessDeniedError('Segregation of duties: requester cannot approve own refund');
    const decisionReason = requiredText(input.decisionReason, 'decisionReason');
    requireDependency(this.repository, 'approveRefundRequest', 'repository');
    try {
      const approved = await this.repository.approveRefundRequest({ refundRequestId:refund.refundRequestId, actorSubject:actor.userId, decisionReason, at:this._now() });
      await this._audit(actor, 'finance.refund.approve', 'refund_request', refund.refundRequestId, { courtId:refund.courtId, reason:decisionReason, details:{ paymentId:refund.paymentId,amountMinor:refund.amountMinor,currency:refund.currency,status:approved.status } });
      await this._emit(actor, 'finance.refund.approved', 'refund_request', refund.refundRequestId, refund.courtId, {
        refundRequestId:refund.refundRequestId,paymentId:refund.paymentId,courtId:refund.courtId,
        amountMinor:refund.amountMinor,currency:refund.currency,status:approved.status
      }, approved.decidedAt);
      return approved;
    } catch (error) { return this._mapConflict(error, 'Refund approval conflict'); }
  }

  async rejectRefund(actor, refundRequestId, input = {}) {
    const refund = await this._refundFor(actor, refundRequestId, 'finance.refund.approve');
    if (refund.status !== 'REQUESTED') throw new ConflictError(`Refund cannot be rejected from status ${refund.status}`);
    if (refund.requestedBy === actor.userId) throw new AccessDeniedError('Segregation of duties: requester cannot reject own refund');
    const decisionReason = requiredText(input.decisionReason, 'decisionReason');
    requireDependency(this.repository, 'rejectRefundRequest', 'repository');
    try {
      const rejected = await this.repository.rejectRefundRequest({ refundRequestId:refund.refundRequestId, actorSubject:actor.userId, decisionReason, at:this._now() });
      await this._audit(actor, 'finance.refund.reject', 'refund_request', refund.refundRequestId, { courtId:refund.courtId, reason:decisionReason, details:{ paymentId:refund.paymentId,status:rejected.status } });
      return rejected;
    } catch (error) { return this._mapConflict(error, 'Refund rejection conflict'); }
  }

  async completeRefund(actor, refundRequestId, input = {}) {
    const refund = await this._refundFor(actor, refundRequestId, 'finance.refund.complete');
    if (refund.status !== 'APPROVED') throw new ConflictError(`Refund cannot be completed from status ${refund.status}`);
    const providerRefundReference = requiredText(input.providerRefundReference, 'providerRefundReference', { max: 200 });
    requireDependency(this.repository, 'completeRefundRequest', 'repository');
    try {
      const completed = await this.repository.completeRefundRequest({ refundRequestId:refund.refundRequestId, actorSubject:actor.userId, providerRefundReference, at:this._now() });
      await this._audit(actor, 'finance.refund.complete', 'refund_request', refund.refundRequestId, { courtId:refund.courtId, details:{ paymentId:refund.paymentId,amountMinor:refund.amountMinor,currency:refund.currency,providerRefundReference,status:completed.status } });
      await this._emit(actor, 'finance.refund.completed', 'refund_request', refund.refundRequestId, refund.courtId, {
        refundRequestId:refund.refundRequestId,paymentId:refund.paymentId,courtId:refund.courtId,
        amountMinor:refund.amountMinor,currency:refund.currency,status:completed.status
      }, completed.completedAt);
      return completed;
    } catch (error) { return this._mapConflict(error, 'Refund completion conflict'); }
  }

  async rejectReconciliation(actor, reconciliationId, input = {}) {
    const id = requiredText(reconciliationId, 'reconciliationId', { max: 160 });
    requireDependency(this.repository, 'getReconciliation', 'repository');
    requireDependency(this.repository, 'rejectReconciliation', 'repository');
    const reconciliation = await this.repository.getReconciliation(id);
    if (!reconciliation) throw new NotFoundError('Reconciliation not found');
    authorize(actor, 'finance.reconciliation.reject', { courtId: reconciliation.courtId });
    if (reconciliation.status !== 'PREPARED') throw new ConflictError(`Reconciliation cannot be rejected from status ${reconciliation.status}`);
    if (reconciliation.preparedBy === actor.userId) throw new AccessDeniedError('Segregation of duties: preparer cannot reject own reconciliation');
    const reason = requiredText(input.reason, 'reason');
    const exceptionCode = stableCode(input.exceptionCode, 'exceptionCode', { max: 60 });
    try {
      const rejected = await this.repository.rejectReconciliation({ reconciliationId:id, actorSubject:actor.userId, reason, exceptionCode, at:this._now() });
      await this._audit(actor, 'finance.reconciliation.reject', 'reconciliation', id, { courtId:reconciliation.courtId, reason, details:{ paymentId:reconciliation.paymentId,exceptionCode,status:rejected.status } });
      await this._emit(actor, 'finance.reconciliation.rejected', 'reconciliation', id, reconciliation.courtId, {
        reconciliationId:id,paymentId:reconciliation.paymentId,courtId:reconciliation.courtId,exceptionCode,status:rejected.status
      }, rejected.rejectedAt);
      return rejected;
    } catch (error) { return this._mapConflict(error, 'Reconciliation rejection conflict'); }
  }

  async listReconciliationExceptions(actor) {
    authorize(actor, 'finance.reconciliation.exception.view', {});
    requireDependency(this.repository, 'listReconciliationExceptions', 'repository');
    return this.repository.listReconciliationExceptions({ courtIds: actor.courtIds });
  }
}

module.exports = { FinanceCompletionService };
