'use strict';
const { randomUUID } = require('node:crypto');
const { authorize, AccessDeniedError } = require('../../../packages/rbac');
const { AuditStore } = require('../../../packages/audit');
const { ConflictError, NotFoundError, ValidationError } = require('./dciecms-service');

class PersistentDciecmsService {
  constructor({ repository, auditStore = new AuditStore() } = {}) {
    if (!repository) throw new TypeError('PersistentDciecmsService requires a repository');
    this.repository = repository;
    this.audit = auditStore;
    this.idempotency = new Map();
  }

  _audit(actor, action, resourceType, resourceId, details = {}) {
    return this.audit.append({ actorUserId: actor.userId, effectiveRoles: actor.roles, action, resourceType, resourceId, ...details });
  }

  _requireRegistry(actor) {
    if (!actor.roles.includes('REG') && !actor.roles.includes('REG-MGR')) throw new AccessDeniedError('Registry role required');
  }

  _requireRegistryManager(actor) {
    if (!actor.roles.includes('REG-MGR')) throw new AccessDeniedError('REG-MGR manager role required');
  }

  async createParty(actor, input) {
    if (!input?.courtId || !input?.partyType || !input?.displayName) throw new ValidationError('courtId, partyType and displayName are required');
    authorize(actor, 'party.create', { courtId: input.courtId });
    const party = await this.repository.createParty({ partyId: randomUUID(), courtId: input.courtId, partyType: input.partyType, displayName: input.displayName });
    this._audit(actor, 'party.create', 'party', party.partyId, { courtId: party.courtId });
    return party;
  }

  async createFilingDraft(actor, input) {
    if (!input?.courtId || !input?.caseTypeCode || !input?.filerPartyId) throw new ValidationError('courtId, caseTypeCode and filerPartyId are required');
    authorize(actor, 'filing.create', { courtId: input.courtId });
    const caseTypeCode = String(input.caseTypeCode).trim().toUpperCase();
    if (!(await this.repository.isCaseTypeActive(caseTypeCode))) throw new ValidationError(`Unknown or inactive case type: ${caseTypeCode}`);
    const party = await this.repository.getParty(input.filerPartyId);
    if (!party || party.courtId !== input.courtId) throw new ValidationError('Filer party is not available in the selected court scope');
    const filing = await this.repository.createFilingDraft({
      filingId: randomUUID(),
      filingReference: `F-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      courtId: input.courtId,
      caseTypeCode,
      filerPartyId: input.filerPartyId,
      createdBy: actor.userId
    });
    this._audit(actor, 'filing.create', 'filing', filing.filingId, { courtId: filing.courtId, caseTypeCode });
    return filing;
  }

  async _filingForAccess(actor, filingId, permission) {
    const filing = await this.repository.getFiling(filingId);
    if (!filing) throw new NotFoundError('Filing not found');
    authorize(actor, permission, { courtId: filing.courtId });
    return filing;
  }

  async listRegistryQueue(actor) {
    authorize(actor, 'filing.view', {});
    this._requireRegistry(actor);
    const rows = await this.repository.listRegistryQueue({ courtIds: actor.courtIds });
    this._audit(actor, 'registry.queue.view', 'filing_queue', actor.courtIds.join(','), { courtIds: actor.courtIds });
    return rows;
  }

  async registerDocument(actor, filingId, metadata) {
    const filing = await this._filingForAccess(actor, filingId, 'filing.view');
    authorize(actor, 'document.upload', { courtId: filing.courtId });
    if (!metadata?.fileName || !metadata?.mimeType || !metadata?.checksumSha256) throw new ValidationError('fileName, mimeType and checksumSha256 are required');
    if (!/^[a-f0-9]{64}$/i.test(metadata.checksumSha256)) throw new ValidationError('checksumSha256 must be a SHA-256 hex digest');
    const document = await this.repository.createDocument({
      documentId: randomUUID(),
      filingId,
      courtId: filing.courtId,
      fileName: metadata.fileName,
      mimeType: metadata.mimeType,
      sizeBytes: Number(metadata.sizeBytes || 0),
      checksumSha256: metadata.checksumSha256.toLowerCase(),
      classification: metadata.classification || 'CONFIDENTIAL'
    });
    this._audit(actor, 'document.upload', 'document', document.documentId, { courtId: filing.courtId, filingId });
    return document;
  }

  async getDocument(actor, documentId) {
    const document = await this.repository.getDocument(documentId);
    if (!document) throw new NotFoundError('Document not found');
    authorize(actor, 'document.view', { courtId: document.courtId });
    this._audit(actor, 'document.view', 'document', document.documentId, { courtId: document.courtId, filingId: document.filingId });
    return document;
  }

  async submitFiling(actor, filingId, idempotencyKey) {
    if (!idempotencyKey) throw new ValidationError('Idempotency key is required');
    const filing = await this._filingForAccess(actor, filingId, 'filing.submit');
    const key = `${actor.userId}:${filingId}:${idempotencyKey}`;
    if (this.idempotency.has(key)) return this.idempotency.get(key);
    if (filing.status !== 'DRAFT') throw new ConflictError(`Filing cannot be submitted from status ${filing.status}`);
    try {
      const submitted = await this.repository.submitFilingAndCreateTask({ filingId, taskId: randomUUID(), actorSubject: actor.userId, submittedAt: new Date().toISOString() });
      this.idempotency.set(key, submitted);
      this._audit(actor, 'filing.submit', 'filing', filingId, { courtId: filing.courtId, idempotencyKey });
      return submitted;
    } catch (error) {
      if (error.code === 'FILING_STATE_CONFLICT') throw new ConflictError('Filing submission state conflict');
      throw error;
    }
  }

  async validateFiling(actor, filingId) {
    this._requireRegistry(actor);
    const filing = await this._filingForAccess(actor, filingId, 'filing.validate');
    if (filing.status !== 'SUBMITTED') throw new ConflictError(`Filing cannot be validated from status ${filing.status}`);
    const task = await this.repository.findActiveRegistryValidationTask(filingId);
    if (!task) throw new ConflictError('Registry validation task is missing or already completed');
    try {
      const validated = await this.repository.validateFilingAndCompleteTask({ filingId, taskId: task.taskId, actorSubject: actor.userId, validatedAt: new Date().toISOString() });
      this._audit(actor, 'filing.validate', 'filing', filingId, { courtId: filing.courtId, workflowTaskId: task.taskId });
      return validated;
    } catch (error) {
      if (error.code === 'FILING_STATE_CONFLICT' || error.code === 'TASK_STATE_CONFLICT') throw new ConflictError(error.message);
      throw error;
    }
  }

  async returnFiling(actor, filingId, reason) {
    this._requireRegistry(actor);
    if (!String(reason || '').trim()) throw new ValidationError('A return reason is required');
    const filing = await this._filingForAccess(actor, filingId, 'filing.return');
    try {
      const returned = await this.repository.transitionFiling({ filingId, fromStatuses: ['SUBMITTED'], toStatus: 'RETURNED', actorSubject: actor.userId, reason: String(reason).trim(), at: new Date().toISOString() });
      this._audit(actor, 'filing.return', 'filing', filingId, { courtId: filing.courtId, reason: String(reason).trim() });
      return returned;
    } catch (error) {
      if (error.code === 'FILING_STATE_CONFLICT') throw new ConflictError('Filing return state conflict');
      throw error;
    }
  }

  async rejectFiling(actor, filingId, reason) {
    this._requireRegistryManager(actor);
    if (!String(reason || '').trim()) throw new ValidationError('A rejection reason is required');
    const filing = await this._filingForAccess(actor, filingId, 'filing.reject');
    try {
      const rejected = await this.repository.transitionFiling({ filingId, fromStatuses: ['SUBMITTED', 'VALIDATED'], toStatus: 'REJECTED', actorSubject: actor.userId, reason: String(reason).trim(), at: new Date().toISOString() });
      this._audit(actor, 'filing.reject', 'filing', filingId, { courtId: filing.courtId, reason: String(reason).trim() });
      return rejected;
    } catch (error) {
      if (error.code === 'FILING_STATE_CONFLICT') throw new ConflictError('Filing rejection state conflict');
      throw error;
    }
  }

  async acceptFiling(actor, filingId) {
    this._requireRegistryManager(actor);
    const filing = await this._filingForAccess(actor, filingId, 'filing.accept');
    try {
      const accepted = await this.repository.transitionFiling({ filingId, fromStatuses: ['VALIDATED'], toStatus: 'ACCEPTED', actorSubject: actor.userId, reason: null, at: new Date().toISOString() });
      this._audit(actor, 'filing.accept', 'filing', filingId, { courtId: filing.courtId });
      return accepted;
    } catch (error) {
      if (error.code === 'FILING_STATE_CONFLICT') throw new ConflictError('Filing acceptance state conflict');
      throw error;
    }
  }

  async assessFilingFee(actor, filingId, input) {
    const filing = await this._filingForAccess(actor, filingId, 'finance.assess');
    if (filing.status !== 'ACCEPTED') throw new ConflictError(`Fee assessment requires ACCEPTED filing, got ${filing.status}`);
    const amountMinor = input?.amountMinor;
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new ValidationError('amountMinor must be a positive integer');
    const currency = String(input?.currency || 'PGK').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError('currency must be a 3-letter code');
    const assessment = await this.repository.createFeeAssessment({ assessmentId: randomUUID(), filingId, courtId: filing.courtId, amountMinor, currency, actorSubject: actor.userId, at: new Date().toISOString() });
    this._audit(actor, 'finance.fee.assess', 'fee_assessment', assessment.assessmentId, { courtId: filing.courtId, filingId, amountMinor, currency });
    return assessment;
  }

  async createPayment(actor, assessmentId) {
    const assessment = await this.repository.getFeeAssessment(assessmentId);
    if (!assessment) throw new NotFoundError('Fee assessment not found');
    authorize(actor, 'finance.payment.create', { courtId: assessment.courtId });
    if (assessment.status !== 'ASSESSED') throw new ConflictError(`Payment cannot be created for assessment status ${assessment.status}`);
    const payment = await this.repository.createPayment({ paymentId: randomUUID(), assessmentId, courtId: assessment.courtId, amountMinor: assessment.amountMinor, currency: assessment.currency, actorSubject: actor.userId, at: new Date().toISOString() });
    this._audit(actor, 'finance.payment.create', 'payment', payment.paymentId, { courtId: assessment.courtId, assessmentId, amountMinor: payment.amountMinor, currency: payment.currency });
    return payment;
  }

  async confirmPayment(actor, paymentId, providerReference) {
    const payment = await this.repository.getPayment(paymentId);
    if (!payment) throw new NotFoundError('Payment not found');
    authorize(actor, 'finance.payment.confirm', { courtId: payment.courtId });
    if (!String(providerReference || '').trim()) throw new ValidationError('providerReference is required');
    if (payment.status !== 'PENDING') throw new ConflictError(`Payment cannot be confirmed from status ${payment.status}`);
    const confirmed = await this.repository.confirmPayment({ paymentId, providerReference: String(providerReference).trim(), actorSubject: actor.userId, at: new Date().toISOString() });
    this._audit(actor, 'finance.payment.confirm', 'payment', paymentId, { courtId: payment.courtId, providerReference: String(providerReference).trim() });
    return confirmed;
  }
}

module.exports = { PersistentDciecmsService };
