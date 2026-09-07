'use strict';

const { randomUUID } = require('node:crypto');
const { authorize, AccessDeniedError } = require('../../../packages/rbac');
const { ConflictError, NotFoundError, ValidationError } = require('./dciecms-service');

function normalizeClock(clock) {
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.now === 'function') return () => clock.now();
  return () => new Date();
}

function requiredText(value, label, { upper = false, max = 5000 } = {}) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new ValidationError(`${label} is required`);
  if (normalized.length > max) throw new ValidationError(`${label} is too long`);
  return upper ? normalized.toUpperCase() : normalized;
}

function normalizedCode(value, label) {
  const code = requiredText(value, label, { upper: true, max: 80 });
  if (!/^[A-Z0-9][A-Z0-9._-]{0,79}$/.test(code)) {
    throw new ValidationError(`${label} must be a stable code`);
  }
  return code;
}

function isoInstant(value, label) {
  const raw = requiredText(value, label, { max: 80 });
  const millis = Date.parse(raw);
  if (!Number.isFinite(millis)) throw new ValidationError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
}

function requireDependency(value, method, label) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`${label} must expose ${method}()`);
  }
}

class CaseLifecycleRecordsService {
  constructor({ repository, auditStore, outboxStore = null, clock = () => new Date(), uuid = randomUUID } = {}) {
    requireDependency(repository, 'getCase', 'repository');
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

  async _emit(actor, eventType, aggregateType, aggregateId, courtId, payload = {}) {
    if (!this.outboxStore) return null;
    return this.outboxStore.enqueue({
      eventType,
      aggregateType,
      aggregateId,
      courtId,
      actorSubject: actor.userId,
      correlationId: actor.correlationId || null,
      deduplicationKey: `${aggregateId}:${eventType}`,
      payload,
      headers: { schemaVersion: 1 }
    });
  }

  async _caseFor(actor, caseId, permission) {
    const normalizedCaseId = requiredText(caseId, 'caseId', { max: 160 });
    const courtCase = await this.repository.getCase(normalizedCaseId);
    if (!courtCase) throw new NotFoundError('Case not found');
    authorize(actor, permission, { courtId: courtCase.courtId });
    return courtCase;
  }

  _requireAssignedMagistrate(actor, courtCase) {
    if (actor.roles.includes('MAG') && !actor.roles.includes('CMAG') && courtCase.assignedToSubject !== actor.userId) {
      throw new AccessDeniedError('Case is not assigned to this magistrate');
    }
  }

  _mapRepositoryConflict(error, message) {
    const code = String(error?.code || '');
    if (code === 'CASE_LIFECYCLE_CONFLICT' || code === 'RECORDS_STATE_CONFLICT' || code === 'RECORDS_SOD_CONFLICT') {
      const conflict = new ConflictError(message);
      conflict.code = code;
      throw conflict;
    }
    throw error;
  }

  async disposeCase(actor, caseId, input = {}) {
    const courtCase = await this._caseFor(actor, caseId, 'case.disposition');
    this._requireAssignedMagistrate(actor, courtCase);
    if (courtCase.status !== 'ASSIGNED') throw new ConflictError(`Case cannot be disposed from status ${courtCase.status}`);

    const dispositionCode = normalizedCode(input.dispositionCode, 'dispositionCode');
    const reason = requiredText(input.reason, 'reason');
    const judgmentId = input.judgmentId ? requiredText(input.judgmentId, 'judgmentId', { max: 160 }) : null;

    requireDependency(this.repository, 'hasActiveCaseHearing', 'repository');
    if (await this.repository.hasActiveCaseHearing(courtCase.caseId)) {
      throw new ConflictError('Case cannot be disposed while a hearing is active');
    }

    if (judgmentId) {
      requireDependency(this.repository, 'getIssuedJudgmentForCase', 'repository');
      const judgment = await this.repository.getIssuedJudgmentForCase(judgmentId, courtCase.caseId);
      if (!judgment) throw new ValidationError('judgmentId must reference an issued judgment for this case');
    }

    requireDependency(this.repository, 'disposeCase', 'repository');
    try {
      const disposed = await this.repository.disposeCase({
        caseId: courtCase.caseId,
        dispositionCode,
        reason,
        judgmentId,
        actorSubject: actor.userId,
        at: this._now()
      });
      await this._audit(actor, 'case.dispose', 'case', courtCase.caseId, {
        courtId: courtCase.courtId,
        reason,
        details: { dispositionCode, judgmentId }
      });
      await this._emit(actor, 'case.disposed', 'case', courtCase.caseId, courtCase.courtId, {
        caseId: courtCase.caseId,
        courtId: courtCase.courtId,
        status: disposed.status,
        dispositionCode,
        judgmentId
      });
      return disposed;
    } catch (error) {
      return this._mapRepositoryConflict(error, 'Case disposition state conflict');
    }
  }

  async closeCase(actor, caseId, input = {}) {
    const courtCase = await this._caseFor(actor, caseId, 'case.close');
    if (courtCase.status !== 'DISPOSED') throw new ConflictError(`Case cannot be closed from status ${courtCase.status}`);
    const closureCode = normalizedCode(input.closureCode, 'closureCode');
    const reason = requiredText(input.reason, 'reason');
    requireDependency(this.repository, 'closeCase', 'repository');
    try {
      const closed = await this.repository.closeCase({
        caseId: courtCase.caseId,
        closureCode,
        reason,
        actorSubject: actor.userId,
        at: this._now()
      });
      await this._audit(actor, 'case.close', 'case', courtCase.caseId, {
        courtId: courtCase.courtId,
        reason,
        details: { closureCode }
      });
      await this._emit(actor, 'case.closed', 'case', courtCase.caseId, courtCase.courtId, {
        caseId: courtCase.caseId,
        courtId: courtCase.courtId,
        status: closed.status,
        closureCode
      });
      return closed;
    } catch (error) {
      return this._mapRepositoryConflict(error, 'Case closure state conflict');
    }
  }

  async reopenCase(actor, caseId, input = {}) {
    const courtCase = await this._caseFor(actor, caseId, 'case.reopen');
    if (courtCase.status !== 'CLOSED') throw new ConflictError(`Case cannot be reopened from status ${courtCase.status}`);
    const reason = requiredText(input.reason, 'reason');
    requireDependency(this.repository, 'reopenCase', 'repository');
    try {
      const reopened = await this.repository.reopenCase({
        caseId: courtCase.caseId,
        reason,
        actorSubject: actor.userId,
        at: this._now()
      });
      await this._audit(actor, 'case.reopen', 'case', courtCase.caseId, {
        courtId: courtCase.courtId,
        reason
      });
      await this._emit(actor, 'case.reopened', 'case', courtCase.caseId, courtCase.courtId, {
        caseId: courtCase.caseId,
        courtId: courtCase.courtId,
        status: reopened.status
      });
      return reopened;
    } catch (error) {
      return this._mapRepositoryConflict(error, 'Case reopening state conflict');
    }
  }

  async getCaseRecordControl(actor, caseId) {
    const courtCase = await this._caseFor(actor, caseId, 'records.view');
    requireDependency(this.repository, 'getCaseRecordControl', 'repository');
    const control = await this.repository.getCaseRecordControl(courtCase.caseId);
    if (!control) throw new NotFoundError('Case record control not found');
    await this._audit(actor, 'records.view', 'case_record_control', control.caseRecordControlId, {
      courtId: courtCase.courtId,
      details: { caseId: courtCase.caseId }
    });
    return control;
  }

  async assignRetention(actor, caseId, input = {}) {
    const courtCase = await this._caseFor(actor, caseId, 'records.retention.assign');
    if (courtCase.status !== 'CLOSED') throw new ConflictError('Retention may be assigned only to a closed case');
    const retentionClassCode = normalizedCode(input.retentionClassCode, 'retentionClassCode');
    const retentionTriggerAt = isoInstant(input.retentionTriggerAt, 'retentionTriggerAt');
    const dispositionEligibleAt = isoInstant(input.dispositionEligibleAt, 'dispositionEligibleAt');
    if (Date.parse(dispositionEligibleAt) < Date.parse(retentionTriggerAt)) {
      throw new ValidationError('dispositionEligibleAt must not precede retentionTriggerAt');
    }
    requireDependency(this.repository, 'assignRetention', 'repository');
    try {
      const control = await this.repository.assignRetention({
        caseId: courtCase.caseId,
        retentionClassCode,
        retentionTriggerAt,
        dispositionEligibleAt,
        actorSubject: actor.userId,
        at: this._now()
      });
      await this._audit(actor, 'records.retention.assign', 'case_record_control', control.caseRecordControlId, {
        courtId: courtCase.courtId,
        details: { caseId: courtCase.caseId, retentionClassCode, retentionTriggerAt, dispositionEligibleAt }
      });
      return control;
    } catch (error) {
      return this._mapRepositoryConflict(error, 'Records retention state conflict');
    }
  }

  async archiveCaseRecord(actor, caseId) {
    const courtCase = await this._caseFor(actor, caseId, 'records.archive');
    if (courtCase.status !== 'CLOSED') throw new ConflictError('Only a closed case record may be archived');
    requireDependency(this.repository, 'archiveCaseRecord', 'repository');
    try {
      const control = await this.repository.archiveCaseRecord({ caseId: courtCase.caseId, actorSubject: actor.userId, at: this._now() });
      await this._audit(actor, 'records.archive', 'case_record_control', control.caseRecordControlId, {
        courtId: courtCase.courtId,
        details: { caseId: courtCase.caseId }
      });
      await this._emit(actor, 'records.archived', 'case_record_control', control.caseRecordControlId, courtCase.courtId, {
        caseId: courtCase.caseId,
        courtId: courtCase.courtId,
        caseRecordControlId: control.caseRecordControlId,
        status: control.status
      });
      return control;
    } catch (error) {
      return this._mapRepositoryConflict(error, 'Records archive state conflict');
    }
  }

  async setCaseLegalHold(actor, caseId, input = {}) {
    const courtCase = await this._caseFor(actor, caseId, 'records.legal_hold.manage');
    const reference = requiredText(input.reference, 'reference', { max: 160 });
    const reason = requiredText(input.reason, 'reason');
    requireDependency(this.repository, 'setCaseLegalHold', 'repository');
    try {
      const control = await this.repository.setCaseLegalHold({
        caseId: courtCase.caseId,
        reference,
        reason,
        actorSubject: actor.userId,
        at: this._now()
      });
      await this._audit(actor, 'records.legal_hold.set', 'case_record_control', control.caseRecordControlId, {
        courtId: courtCase.courtId,
        reason,
        details: { caseId: courtCase.caseId, legalHoldReference: reference }
      });
      return control;
    } catch (error) {
      return this._mapRepositoryConflict(error, 'Records legal hold state conflict');
    }
  }

  async releaseCaseLegalHold(actor, caseId, input = {}) {
    const courtCase = await this._caseFor(actor, caseId, 'records.legal_hold.manage');
    const reason = requiredText(input.reason, 'reason');
    requireDependency(this.repository, 'releaseCaseLegalHold', 'repository');
    try {
      const control = await this.repository.releaseCaseLegalHold({ caseId: courtCase.caseId, actorSubject: actor.userId, at: this._now() });
      await this._audit(actor, 'records.legal_hold.release', 'case_record_control', control.caseRecordControlId, {
        courtId: courtCase.courtId,
        reason,
        details: { caseId: courtCase.caseId }
      });
      return control;
    } catch (error) {
      return this._mapRepositoryConflict(error, 'Records legal hold release conflict');
    }
  }

  async requestCaseRecordDisposal(actor, caseId, input = {}) {
    const courtCase = await this._caseFor(actor, caseId, 'records.disposal.request');
    if (courtCase.status !== 'CLOSED') throw new ConflictError('Only a closed case record may enter disposal review');
    const reason = requiredText(input.reason, 'reason');
    requireDependency(this.repository, 'getCaseRecordControl', 'repository');
    requireDependency(this.repository, 'hasDocumentLegalHold', 'repository');
    requireDependency(this.repository, 'createDisposalRequest', 'repository');
    const control = await this.repository.getCaseRecordControl(courtCase.caseId);
    if (!control) throw new NotFoundError('Case record control not found');
    if (control.legalHold || await this.repository.hasDocumentLegalHold(courtCase.caseId)) {
      throw new ConflictError('Case record is protected by a legal hold');
    }
    try {
      const request = await this.repository.createDisposalRequest({
        disposalRequestId: this.uuid(),
        caseId: courtCase.caseId,
        reason,
        actorSubject: actor.userId,
        at: this._now()
      });
      await this._audit(actor, 'records.disposal.request', 'disposal_request', request.disposalRequestId, {
        courtId: courtCase.courtId,
        reason,
        details: { caseId: courtCase.caseId, caseRecordControlId: request.caseRecordControlId }
      });
      return request;
    } catch (error) {
      return this._mapRepositoryConflict(error, 'Records disposal request conflict');
    }
  }

  async _disposalDecisionContext(actor, disposalRequestId) {
    const requestId = requiredText(disposalRequestId, 'disposalRequestId', { max: 160 });
    requireDependency(this.repository, 'getDisposalRequest', 'repository');
    const request = await this.repository.getDisposalRequest(requestId);
    if (!request) throw new NotFoundError('Disposal request not found');
    authorize(actor, 'records.disposal.approve', { courtId: request.courtId });
    if (request.status !== 'REQUESTED') throw new ConflictError('Disposal request is no longer pending');
    if (request.requestedBy === actor.userId) throw new ConflictError('Disposal requester cannot decide the same request');
    return request;
  }

  async approveCaseRecordDisposal(actor, disposalRequestId, input = {}) {
    const request = await this._disposalDecisionContext(actor, disposalRequestId);
    const decisionReason = requiredText(input.reason, 'reason');
    requireDependency(this.repository, 'getCaseRecordControl', 'repository');
    requireDependency(this.repository, 'hasDocumentLegalHold', 'repository');
    requireDependency(this.repository, 'approveDisposalRequest', 'repository');
    const control = await this.repository.getCaseRecordControl(request.caseId);
    if (!control) throw new NotFoundError('Case record control not found');
    if (control.legalHold || await this.repository.hasDocumentLegalHold(request.caseId)) {
      throw new ConflictError('Case record is protected by a legal hold');
    }
    try {
      const decided = await this.repository.approveDisposalRequest({
        disposalRequestId: request.disposalRequestId,
        actorSubject: actor.userId,
        decisionReason,
        at: this._now()
      });
      await this._audit(actor, 'records.disposal.approve', 'disposal_request', request.disposalRequestId, {
        courtId: request.courtId,
        reason: decisionReason,
        details: { caseId: request.caseId, caseRecordControlId: request.caseRecordControlId }
      });
      await this._emit(actor, 'records.disposal.approved', 'disposal_request', request.disposalRequestId, request.courtId, {
        disposalRequestId: request.disposalRequestId,
        caseRecordControlId: request.caseRecordControlId,
        caseId: request.caseId,
        courtId: request.courtId,
        status: decided.status
      });
      return decided;
    } catch (error) {
      return this._mapRepositoryConflict(error, 'Records disposal approval conflict');
    }
  }

  async rejectCaseRecordDisposal(actor, disposalRequestId, input = {}) {
    const request = await this._disposalDecisionContext(actor, disposalRequestId);
    const decisionReason = requiredText(input.reason, 'reason');
    requireDependency(this.repository, 'rejectDisposalRequest', 'repository');
    try {
      const decided = await this.repository.rejectDisposalRequest({
        disposalRequestId: request.disposalRequestId,
        actorSubject: actor.userId,
        decisionReason,
        at: this._now()
      });
      await this._audit(actor, 'records.disposal.reject', 'disposal_request', request.disposalRequestId, {
        courtId: request.courtId,
        reason: decisionReason,
        details: { caseId: request.caseId, caseRecordControlId: request.caseRecordControlId }
      });
      return decided;
    } catch (error) {
      return this._mapRepositoryConflict(error, 'Records disposal rejection conflict');
    }
  }
}

module.exports = { CaseLifecycleRecordsService, normalizedCode, isoInstant };
