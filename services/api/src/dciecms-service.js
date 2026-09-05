'use strict';
const { randomUUID } = require('node:crypto');
const { authorize, AccessDeniedError } = require('../../../packages/rbac');
const { AuditStore } = require('../../../packages/audit');

class NotFoundError extends Error { constructor(message='Not found'){ super(message); this.name='NotFoundError'; this.statusCode=404; } }
class ConflictError extends Error { constructor(message='Conflict'){ super(message); this.name='ConflictError'; this.statusCode=409; } }
class ValidationError extends Error { constructor(message='Validation failed'){ super(message); this.name='ValidationError'; this.statusCode=422; } }

const DEFAULT_CASE_TYPES = Object.freeze([
  'CIVIL',
  'CRIMINAL',
  'TRAFFIC',
  'FAMILY',
  'JUVENILE',
  'ADMINISTRATIVE'
]);

class DciecmsService {
  constructor({ auditStore = new AuditStore(), caseTypes = DEFAULT_CASE_TYPES } = {}) {
    this.audit = auditStore;
    this.parties = new Map();
    this.filings = new Map();
    this.documents = new Map();
    this.workflowTasks = new Map();
    this.idempotency = new Map();
    this.caseTypes = new Set(caseTypes.map(code => String(code).trim().toUpperCase()));
  }

  _audit(actor, action, resourceType, resourceId, details={}) {
    return this.audit.append({ actorUserId: actor.userId, effectiveRoles: actor.roles, action, resourceType, resourceId, ...details });
  }

  _isRegistryActor(actor) {
    return actor.roles.includes('REG') || actor.roles.includes('REG-MGR');
  }

  _createRegistryValidationTask(filing) {
    const existing = [...this.workflowTasks.values()].find(task =>
      task.filingId === filing.filingId &&
      task.taskType === 'REGISTRY_VALIDATE_FILING' &&
      task.status !== 'COMPLETED' &&
      task.status !== 'CANCELLED'
    );
    if (existing) return existing;

    const task = {
      taskId: randomUUID(),
      filingId: filing.filingId,
      courtId: filing.courtId,
      taskType: 'REGISTRY_VALIDATE_FILING',
      assignedRole: 'REG',
      priority: 'NORMAL',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      completedAt: null,
      completedBy: null
    };
    this.workflowTasks.set(task.taskId, task);
    return task;
  }

  createParty(actor, input) {
    if (!input?.courtId || !input?.partyType || !input?.displayName) throw new ValidationError('courtId, partyType and displayName are required');
    authorize(actor, 'party.create', { courtId: input.courtId });
    const party = Object.freeze({ partyId: randomUUID(), courtId: input.courtId, partyType: input.partyType, displayName: input.displayName, createdAt: new Date().toISOString() });
    this.parties.set(party.partyId, party);
    this._audit(actor, 'party.create', 'party', party.partyId, { courtId: party.courtId });
    return party;
  }

  createFilingDraft(actor, input) {
    if (!input?.courtId || !input?.caseTypeCode || !input?.filerPartyId) throw new ValidationError('courtId, caseTypeCode and filerPartyId are required');
    authorize(actor, 'filing.create', { courtId: input.courtId });
    const caseTypeCode = String(input.caseTypeCode).trim().toUpperCase();
    if (!this.caseTypes.has(caseTypeCode)) throw new ValidationError(`Unknown or inactive case type: ${caseTypeCode}`);
    const party = this.parties.get(input.filerPartyId);
    if (!party || party.courtId !== input.courtId) throw new ValidationError('Filer party is not available in the selected court scope');
    const filing = {
      filingId: randomUUID(),
      filingReference: `F-${Date.now()}-${Math.floor(Math.random()*10000)}`,
      courtId: input.courtId,
      caseTypeCode,
      filerPartyId: input.filerPartyId,
      status: 'DRAFT',
      createdBy: actor.userId,
      createdAt: new Date().toISOString(),
      submittedAt: null,
      validatedAt: null,
      validatedBy: null
    };
    this.filings.set(filing.filingId, filing);
    this._audit(actor, 'filing.create', 'filing', filing.filingId, { courtId: filing.courtId, caseTypeCode });
    return Object.freeze({...filing});
  }

  _filingForAccess(actor, filingId, permission='filing.view') {
    const filing = this.filings.get(filingId);
    if (!filing) throw new NotFoundError('Filing not found');
    authorize(actor, permission, { courtId: filing.courtId });
    return filing;
  }

  getFiling(actor, filingId) {
    return Object.freeze({...this._filingForAccess(actor, filingId, 'filing.view')});
  }

  registerDocument(actor, filingId, metadata) {
    const filing = this._filingForAccess(actor, filingId, 'filing.view');
    authorize(actor, 'document.upload', { courtId: filing.courtId });
    if (!metadata?.fileName || !metadata?.mimeType || !metadata?.checksumSha256) throw new ValidationError('fileName, mimeType and checksumSha256 are required');
    if (!/^[a-f0-9]{64}$/i.test(metadata.checksumSha256)) throw new ValidationError('checksumSha256 must be a SHA-256 hex digest');
    const doc = Object.freeze({
      documentId: randomUUID(),
      filingId,
      courtId: filing.courtId,
      fileName: metadata.fileName,
      mimeType: metadata.mimeType,
      sizeBytes: Number(metadata.sizeBytes || 0),
      checksumSha256: metadata.checksumSha256.toLowerCase(),
      status: 'QUARANTINED',
      classification: metadata.classification || 'CONFIDENTIAL',
      createdAt: new Date().toISOString()
    });
    this.documents.set(doc.documentId, doc);
    this._audit(actor, 'document.upload', 'document', doc.documentId, { courtId: doc.courtId, filingId });
    return doc;
  }

  getDocument(actor, documentId) {
    const doc = this.documents.get(documentId);
    if (!doc) throw new NotFoundError('Document not found');
    authorize(actor, 'document.view', { courtId: doc.courtId });
    this._audit(actor, 'document.view', 'document', doc.documentId, { courtId: doc.courtId, filingId: doc.filingId });
    return doc;
  }

  submitFiling(actor, filingId, idempotencyKey) {
    if (!idempotencyKey) throw new ValidationError('Idempotency key is required');
    const filing = this._filingForAccess(actor, filingId, 'filing.submit');
    const idemKey = `${actor.userId}:${filingId}:${idempotencyKey}`;
    const existing = this.idempotency.get(idemKey);
    if (existing) return Object.freeze({ ...existing });
    if (filing.status !== 'DRAFT') throw new ConflictError(`Filing cannot be submitted from status ${filing.status}`);

    filing.status = 'SUBMITTED';
    filing.submittedAt = new Date().toISOString();
    this._createRegistryValidationTask(filing);

    const result = { ...filing };
    this.idempotency.set(idemKey, result);
    this._audit(actor, 'filing.submit', 'filing', filing.filingId, { courtId: filing.courtId, idempotencyKey });
    return Object.freeze({ ...result });
  }

  validateFiling(actor, filingId) {
    const filing = this._filingForAccess(actor, filingId, 'filing.validate');
    if (!this._isRegistryActor(actor)) throw new AccessDeniedError('Registry role required');
    if (filing.status !== 'SUBMITTED') throw new ConflictError(`Filing cannot be validated from status ${filing.status}`);

    const task = [...this.workflowTasks.values()].find(item =>
      item.filingId === filingId &&
      item.taskType === 'REGISTRY_VALIDATE_FILING' &&
      item.status !== 'COMPLETED' &&
      item.status !== 'CANCELLED'
    );
    if (!task) throw new ConflictError('Registry validation task is missing or already completed');

    const now = new Date().toISOString();
    filing.status = 'VALIDATED';
    filing.validatedAt = now;
    filing.validatedBy = actor.userId;
    task.status = 'COMPLETED';
    task.completedAt = now;
    task.completedBy = actor.userId;

    this._audit(actor, 'filing.validate', 'filing', filing.filingId, { courtId: filing.courtId, workflowTaskId: task.taskId });
    this._audit(actor, 'workflow.task.complete', 'workflow_task', task.taskId, { courtId: task.courtId, filingId: filing.filingId });
    return Object.freeze({ ...filing });
  }

  listWorkflowTasks(actor, { includeCompleted = false } = {}) {
    authorize(actor, 'task.view', {});
    if (!this._isRegistryActor(actor)) throw new AccessDeniedError('Registry role required');
    const rows = [...this.workflowTasks.values()]
      .filter(task => actor.courtIds.includes(task.courtId))
      .filter(task => includeCompleted || task.status !== 'COMPLETED')
      .map(task => Object.freeze({ ...task }));
    this._audit(actor, 'workflow.task.list', 'workflow_task_queue', actor.courtIds.join(','), { courtIds: actor.courtIds, includeCompleted });
    return rows;
  }

  listRegistryQueue(actor) {
    authorize(actor, 'filing.view', {});
    if (!this._isRegistryActor(actor)) throw new AccessDeniedError('Registry role required');
    const rows = [...this.filings.values()]
      .filter(f => f.status === 'SUBMITTED' && actor.courtIds.includes(f.courtId))
      .map(f => Object.freeze({ ...f }));
    this._audit(actor, 'registry.queue.view', 'filing_queue', actor.courtIds.join(','), { courtIds: actor.courtIds });
    return rows;
  }
}

module.exports = { DciecmsService, NotFoundError, ConflictError, ValidationError, DEFAULT_CASE_TYPES };
