'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { authorize, AccessDeniedError } = require('../../../packages/rbac');
const {
  DEFAULT_DOCUMENT_POLICY,
  DocumentPolicyError,
  validateDocumentIntent,
  validateAuthoritativeObject,
  authorizeDocumentClassification
} = require('./document-policy');
const { assertDocumentStorage } = require('./document-storage');

class SecureDocumentNotFoundError extends Error {
  constructor(message = 'Secure document resource not found') {
    super(message);
    this.name = 'SecureDocumentNotFoundError';
    this.statusCode = 404;
  }
}

class SecureDocumentConflictError extends Error {
  constructor(message = 'Secure document state conflict') {
    super(message);
    this.name = 'SecureDocumentConflictError';
    this.statusCode = 409;
  }
}

function freezeClone(value) {
  return Object.freeze(JSON.parse(JSON.stringify(value)));
}

function requiredReason(value) {
  const reason = String(value || '').trim();
  if (!reason) throw new DocumentPolicyError('A reason is required');
  return reason;
}

function requiredServiceDependency(value, methodName, label) {
  if (!value || typeof value[methodName] !== 'function') {
    throw new TypeError(`${label} must expose ${methodName}()`);
  }
}

function sanitizedFileName(value) {
  const base = path.basename(String(value || '').trim()).replace(/[^A-Za-z0-9._-]/g, '_');
  const normalized = base.replace(/^\.+/, '').slice(0, 180);
  if (!normalized) throw new DocumentPolicyError('A valid fileName is required');
  return normalized;
}

function safeObjectSegment(value, label) {
  const segment = String(value || '').trim().replace(/[^A-Za-z0-9._-]/g, '_');
  if (!segment) throw new DocumentPolicyError(`${label} is required`);
  return segment;
}

function callerControlsStorage(input = {}) {
  return ['objectKey', 'storageObjectKey', 'storageUrl', 'uploadUrl', 'downloadUrl']
    .some(key => input[key] !== undefined && input[key] !== null);
}

function normalizeClock(clock) {
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.now === 'function') return () => clock.now();
  return () => new Date();
}

function mapRepositoryConflict(error) {
  const code = String(error?.code || '');
  if (code.startsWith('DOCUMENT_') || code === 'SCAN_JOB_STATE_CONFLICT') {
    const conflict = new SecureDocumentConflictError(error.message || 'Secure document state conflict');
    conflict.code = code;
    return conflict;
  }
  return error;
}

function isPublicActor(actor) {
  return Array.isArray(actor?.roles) && actor.roles.includes('PUBLIC');
}

class SecureDocumentService {
  constructor({
    repository,
    storage,
    auditStore,
    scanStore = null,
    clock = () => new Date(),
    uuid = randomUUID,
    grantTtlMs = 5 * 60 * 1000,
    documentPolicy = {}
  } = {}) {
    requiredServiceDependency(repository, 'getDocument', 'repository');
    requiredServiceDependency(repository, 'getFiling', 'repository');
    requiredServiceDependency(auditStore, 'append', 'auditStore');
    assertDocumentStorage(storage);
    if (typeof uuid !== 'function') throw new TypeError('uuid must be a function');
    if (!Number.isInteger(grantTtlMs) || grantTtlMs < 1000 || grantTtlMs > 15 * 60 * 1000) {
      throw new TypeError('grantTtlMs must be an integer between 1000 and 900000');
    }

    this.repository = repository;
    this.storage = storage;
    this.auditStore = auditStore;
    this.scanStore = scanStore;
    this.clock = normalizeClock(clock);
    this.uuid = uuid;
    this.grantTtlMs = grantTtlMs;
    this.documentPolicy = documentPolicy;
  }

  _nowIso() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('clock returned an invalid timestamp');
    return date.toISOString();
  }

  _expiresAt(nowIso) {
    return new Date(Date.parse(nowIso) + this.grantTtlMs).toISOString();
  }

  _objectKey(courtId, documentId, fileName) {
    return `quarantine/${safeObjectSegment(courtId, 'courtId')}/${safeObjectSegment(documentId, 'documentId')}/${sanitizedFileName(fileName)}`;
  }

  async _audit(actor, action, document, details = {}) {
    return this.auditStore.append({
      actorUserId: actor.userId,
      effectiveRoles: [...(actor.roles || [])],
      action,
      resourceType: 'document',
      resourceId: document?.documentId || null,
      courtId: document?.courtId || null,
      correlationId: actor.correlationId || null,
      details: freezeClone(details)
    });
  }

  async _filing(filingId) {
    const filing = await this.repository.getFiling(filingId);
    if (!filing) throw new SecureDocumentNotFoundError('Filing not found');
    return filing;
  }

  async _document(documentId) {
    const document = await this.repository.getDocument(documentId);
    if (!document) throw new SecureDocumentNotFoundError('Document not found');
    return document;
  }

  _assertPublicFilingRelationship(actor, filing) {
    if (isPublicActor(actor) && String(filing?.createdBy || '') !== String(actor?.userId || '')) {
      throw new AccessDeniedError('Public filing relationship required');
    }
  }

  async _filingRelationshipForDocument(actor, document) {
    const filing = await this._filing(document.filingId);
    if (filing.courtId !== document.courtId) {
      throw new SecureDocumentConflictError('Document and filing court do not match');
    }
    this._assertPublicFilingRelationship(actor, filing);
    return filing;
  }

  async _initiate(actor, filing, input, { versionNumber = 1, priorDocumentId = null, action = 'document.upload.initiate' } = {}) {
    requiredServiceDependency(this.repository, 'createDocumentUploadIntent', 'repository');
    if (callerControlsStorage(input)) {
      throw new DocumentPolicyError('Caller-controlled storage or object key is not allowed');
    }
    authorize(actor, 'document.upload', { courtId: filing.courtId });
    const intent = validateDocumentIntent(input, this.documentPolicy);
    const now = this._nowIso();
    const documentId = this.uuid();
    const objectKey = this._objectKey(filing.courtId, documentId, intent.fileName);

    const document = await this.repository.createDocumentUploadIntent({
      documentId,
      filingId: filing.filingId,
      courtId: filing.courtId,
      fileName: intent.fileName,
      mimeType: intent.mimeType,
      expectedSizeBytes: intent.sizeBytes,
      classification: intent.classification,
      storageObjectKey: objectKey,
      actorSubject: actor.userId,
      versionNumber,
      priorDocumentId
    });

    const uploadGrant = await this.storage.createUploadGrant({
      objectKey,
      contentType: intent.mimeType,
      sizeBytes: intent.sizeBytes,
      expiresAt: this._expiresAt(now),
      encryptionRequired: true
    });

    await this._audit(actor, action, document, {
      status: document.status,
      classification: document.classification,
      expectedSizeBytes: intent.sizeBytes,
      versionNumber: document.versionNumber
    });

    return freezeClone({ document, objectKey, uploadGrant });
  }

  async initiateDocumentUpload(actor, filingId, input = {}) {
    const filing = await this._filing(filingId);
    authorize(actor, 'filing.view', { courtId: filing.courtId });
    this._assertPublicFilingRelationship(actor, filing);
    return this._initiate(actor, filing, input);
  }

  async finalizeDocumentUpload(actor, documentId) {
    requiredServiceDependency(this.repository, 'finalizeDocumentAndCreateScanJob', 'repository');
    const document = await this._document(documentId);
    authorize(actor, 'document.upload', { courtId: document.courtId });
    await this._filingRelationshipForDocument(actor, document);
    if (!document.storageObjectKey || !Number.isSafeInteger(Number(document.expectedSizeBytes)) || Number(document.expectedSizeBytes) <= 0) {
      throw new SecureDocumentConflictError('Document upload intent is incomplete');
    }

    const intent = validateDocumentIntent({
      fileName: document.fileName,
      mimeType: document.mimeType,
      sizeBytes: Number(document.expectedSizeBytes),
      classification: document.classification
    }, this.documentPolicy);
    const objectEvidence = await this.storage.headObject({ objectKey: document.storageObjectKey });
    const evidence = validateAuthoritativeObject(intent, objectEvidence, this.documentPolicy);
    const finalizedAt = this._nowIso();

    let finalized;
    try {
      finalized = await this.repository.finalizeDocumentAndCreateScanJob({
        documentId: document.documentId,
        scanJobId: this.uuid(),
        actorSubject: actor.userId,
        sizeBytes: evidence.sizeBytes,
        checksumSha256: evidence.checksumSha256,
        detectedMimeType: evidence.detectedMimeType,
        finalizedAt
      });
    } catch (error) {
      throw mapRepositoryConflict(error);
    }

    await this._audit(actor, 'document.upload.finalize', finalized, {
      status: finalized.status,
      scanStatus: finalized.scanStatus,
      sizeBytes: finalized.sizeBytes,
      detectedMimeType: finalized.detectedMimeType
    });
    return finalized;
  }

  async authorizeDocumentDownload(actor, documentId) {
    const document = await this._document(documentId);
    authorize(actor, 'document.view', { courtId: document.courtId });
    await this._filingRelationshipForDocument(actor, document);
    authorizeDocumentClassification(actor, document, 'view');
    if (document.status !== 'ACTIVE' || !document.storageObjectKey || !document.releasedAt) {
      throw new SecureDocumentConflictError('Document is not ACTIVE and released for download');
    }
    const now = this._nowIso();
    const downloadGrant = await this.storage.createDownloadGrant({
      objectKey: document.storageObjectKey,
      expiresAt: this._expiresAt(now)
    });
    await this._audit(actor, 'document.download.authorize', document, {
      status: document.status,
      classification: document.classification,
      versionNumber: document.versionNumber || 1
    });
    return freezeClone({ documentId: document.documentId, downloadGrant });
  }

  async changeDocumentClassification(actor, documentId, { classification, reason } = {}) {
    requiredServiceDependency(this.repository, 'changeDocumentClassification', 'repository');
    const document = await this._document(documentId);
    authorize(actor, 'document.classification.change', { courtId: document.courtId });
    requiredReason(reason);
    const target = String(classification || '').trim().toUpperCase();
    if (!DEFAULT_DOCUMENT_POLICY.classifications.includes(target)) {
      throw new DocumentPolicyError('Document classification is not allowed');
    }
    let changed;
    try {
      changed = await this.repository.changeDocumentClassification({ documentId, classification: target });
    } catch (error) {
      throw mapRepositoryConflict(error);
    }
    await this._audit(actor, 'document.classification.change', changed, {
      fromClassification: document.classification,
      toClassification: target,
      reasonProvided: true
    });
    return changed;
  }

  async createReplacementDocument(actor, documentId, input = {}) {
    const original = await this._document(documentId);
    authorize(actor, 'document.view', { courtId: original.courtId });
    const filing = await this._filingRelationshipForDocument(actor, original);
    authorizeDocumentClassification(actor, original, 'view');
    authorize(actor, 'document.upload', { courtId: original.courtId });
    if (original.status !== 'ACTIVE') throw new SecureDocumentConflictError('Only an ACTIVE document can be replaced');
    return this._initiate(actor, filing, {
      ...input,
      classification: input.classification ?? original.classification
    }, {
      versionNumber: Number(original.versionNumber || 1) + 1,
      priorDocumentId: original.documentId,
      action: 'document.replacement.initiate'
    });
  }

  async supersedeDocument(actor, documentId, replacementDocumentId, reason) {
    requiredServiceDependency(this.repository, 'supersedeDocument', 'repository');
    const original = await this._document(documentId);
    const replacement = await this._document(replacementDocumentId);
    authorize(actor, 'document.supersede', { courtId: original.courtId });
    requiredReason(reason);
    if (original.documentId === replacement.documentId ||
        original.courtId !== replacement.courtId ||
        original.filingId !== replacement.filingId ||
        original.status !== 'ACTIVE' || replacement.status !== 'ACTIVE') {
      throw new SecureDocumentConflictError('Replacement is not an eligible ACTIVE version for this filing');
    }
    let superseded;
    try {
      superseded = await this.repository.supersedeDocument({ documentId: original.documentId, replacementDocumentId: replacement.documentId });
    } catch (error) {
      throw mapRepositoryConflict(error);
    }
    await this._audit(actor, 'document.supersede', superseded, {
      replacementDocumentId: replacement.documentId,
      reasonProvided: true
    });
    return superseded;
  }

  async withdrawDocument(actor, documentId, reason) {
    requiredServiceDependency(this.repository, 'withdrawDocument', 'repository');
    const document = await this._document(documentId);
    authorize(actor, 'document.withdraw', { courtId: document.courtId });
    const normalizedReason = requiredReason(reason);
    let withdrawn;
    try {
      withdrawn = await this.repository.withdrawDocument({
        documentId: document.documentId,
        actorSubject: actor.userId,
        reason: normalizedReason,
        at: this._nowIso()
      });
    } catch (error) {
      throw mapRepositoryConflict(error);
    }
    await this._audit(actor, 'document.withdraw', withdrawn, { reasonProvided: true });
    return withdrawn;
  }

  async retryDocumentScan(actor, documentId) {
    const document = await this._document(documentId);
    authorize(actor, 'document.scan.retry', { courtId: document.courtId });
    requiredServiceDependency(this.scanStore, 'getByDocumentId', 'scanStore');
    requiredServiceDependency(this.scanStore, 'retryDeadLetter', 'scanStore');
    const job = await this.scanStore.getByDocumentId(document.documentId);
    if (!job) throw new SecureDocumentNotFoundError('Document scan job not found');
    if (job.status !== 'DEAD_LETTER') throw new SecureDocumentConflictError('Document scan job is not in dead-letter state');
    let retried;
    try {
      retried = await this.scanStore.retryDeadLetter({ scanJobId: job.scanJobId, nextAttemptAt: this._nowIso() });
    } catch (error) {
      throw mapRepositoryConflict(error);
    }
    await this._audit(actor, 'document.scan.retry', document, { scanJobId: job.scanJobId });
    return retried;
  }
}

module.exports = {
  SecureDocumentService,
  SecureDocumentNotFoundError,
  SecureDocumentConflictError,
  sanitizedFileName
};
