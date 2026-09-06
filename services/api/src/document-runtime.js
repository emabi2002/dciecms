'use strict';

const { randomUUID } = require('node:crypto');
const { MemoryDocumentStorage, assertDocumentStorage } = require('./document-storage');
const { ScriptedMalwareScanner, assertMalwareScanner } = require('./malware-scanner');

function freezeClone(value) {
  return Object.freeze(JSON.parse(JSON.stringify(value)));
}

function normalizeMode(env, production) {
  const raw = String(env?.DCIECMS_DOCUMENT_PIPELINE_MODE || '').trim().toLowerCase();
  if (!raw) return production ? 'disabled' : 'development';
  if (!['disabled', 'development', 'enabled'].includes(raw)) {
    throw new TypeError('DCIECMS_DOCUMENT_PIPELINE_MODE must be disabled, development, or enabled');
  }
  if (production && raw === 'development') {
    throw new TypeError('Development document pipeline mode is forbidden in production');
  }
  return raw;
}

function createDocumentRuntime({
  env = process.env,
  storage = null,
  scanner = null,
  production = String(env?.NODE_ENV || '').trim().toLowerCase() === 'production'
} = {}) {
  const mode = normalizeMode(env, production);
  if (mode === 'disabled') {
    return Object.freeze({ enabled: false, mode: 'disabled', storage: null, scanner: null });
  }

  if (mode === 'development') {
    const selectedStorage = storage || new MemoryDocumentStorage();
    const selectedScanner = scanner || new ScriptedMalwareScanner([]);
    assertDocumentStorage(selectedStorage);
    assertMalwareScanner(selectedScanner);
    return Object.freeze({ enabled: true, mode, storage: selectedStorage, scanner: selectedScanner });
  }

  if (!storage) throw new TypeError('Production document storage adapter is required when the secure document pipeline is enabled');
  if (!scanner) throw new TypeError('Production malware scanner adapter is required when the secure document pipeline is enabled');
  assertDocumentStorage(storage, { production });
  assertMalwareScanner(scanner);
  return Object.freeze({ enabled: true, mode, storage, scanner });
}

class MemoryDocumentScanStore {
  constructor() {
    this.byDocument = new Map();
  }

  createPending({ scanJobId = randomUUID(), documentId, nextAttemptAt = new Date().toISOString(), maxAttempts = 5 } = {}) {
    const job = freezeClone({
      scanJobId,
      documentId,
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts,
      nextAttemptAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      scannerEngine: null,
      scannerVersion: null,
      resultCode: null,
      lastErrorCode: null,
      createdAt: nextAttemptAt,
      updatedAt: nextAttemptAt,
      completedAt: null
    });
    this.byDocument.set(documentId, job);
    return job;
  }

  async getByDocumentId(documentId) {
    return this.byDocument.get(documentId) || null;
  }

  async retryDeadLetter({ scanJobId, nextAttemptAt = new Date().toISOString() } = {}) {
    const current = [...this.byDocument.values()].find(job => job.scanJobId === scanJobId);
    if (!current || current.status !== 'DEAD_LETTER') {
      const error = new Error('Scan job is not in dead-letter state');
      error.code = 'SCAN_JOB_STATE_CONFLICT';
      throw error;
    }
    const next = freezeClone({ ...current, status:'PENDING', attemptCount:0, nextAttemptAt, leaseOwner:null, leaseExpiresAt:null, resultCode:null, lastErrorCode:null, completedAt:null, updatedAt:nextAttemptAt });
    this.byDocument.set(next.documentId, next);
    return next;
  }
}

class MemorySecureDocumentRepository {
  constructor({ filings, documents, scanStore } = {}) {
    if (!(filings instanceof Map) || !(documents instanceof Map)) throw new TypeError('Memory secure document repository requires filing and document maps');
    this.filings = filings;
    this.documents = documents;
    this.scanStore = scanStore || new MemoryDocumentScanStore();
  }

  async getFiling(filingId) {
    const filing = this.filings.get(filingId);
    return filing ? freezeClone(filing) : null;
  }

  async getDocument(documentId) {
    return this.documents.get(documentId) || null;
  }

  async createDocumentUploadIntent(input) {
    const document = freezeClone({
      documentId: input.documentId,
      filingId: input.filingId,
      courtId: input.courtId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: 0,
      checksumSha256: null,
      status: 'UPLOAD_PENDING',
      classification: input.classification,
      storageObjectKey: input.storageObjectKey,
      versionNumber: Number(input.versionNumber || 1),
      priorDocumentId: input.priorDocumentId || null,
      supersededByDocumentId: null,
      expectedSizeBytes: Number(input.expectedSizeBytes),
      detectedMimeType: null,
      createdBySubject: input.actorSubject,
      finalizedAt: null,
      finalizedBySubject: null,
      filePolicyResult: 'NOT_CHECKED',
      filePolicyCode: null,
      scanStatus: 'NOT_REQUESTED',
      scanResult: null,
      scannerEngine: null,
      scannerVersion: null,
      releasedAt: null,
      withdrawnAt: null,
      withdrawnBySubject: null,
      withdrawalReason: null,
      legalHold: false,
      legalHoldReference: null,
      dispositionEligibleAt: null,
      createdAt: new Date().toISOString()
    });
    this.documents.set(document.documentId, document);
    return document;
  }

  async finalizeDocumentAndCreateScanJob(input) {
    const current = this.documents.get(input.documentId);
    if (!current) return null;
    if (current.status !== 'UPLOAD_PENDING') {
      const exact = current.finalizedAt && current.sizeBytes === Number(input.sizeBytes) && current.checksumSha256 === String(input.checksumSha256).toLowerCase() && current.detectedMimeType === String(input.detectedMimeType).toLowerCase();
      if (exact) return current;
      const error = new Error('Document finalization conflicts with canonical evidence');
      error.code = 'DOCUMENT_FINALIZE_CONFLICT';
      throw error;
    }
    const finalized = freezeClone({
      ...current,
      sizeBytes: Number(input.sizeBytes),
      checksumSha256: String(input.checksumSha256).toLowerCase(),
      detectedMimeType: String(input.detectedMimeType).toLowerCase(),
      status: 'QUARANTINED',
      finalizedAt: input.finalizedAt,
      finalizedBySubject: input.actorSubject,
      filePolicyResult: 'PASSED',
      scanStatus: 'PENDING'
    });
    this.documents.set(finalized.documentId, finalized);
    this.scanStore.createPending({ scanJobId: input.scanJobId, documentId: finalized.documentId, nextAttemptAt: input.finalizedAt, maxAttempts: input.maxAttempts || 5 });
    return finalized;
  }

  async activateCleanDocument({ documentId, scannerEngine, scannerVersion, releasedAt }) {
    const current = this.documents.get(documentId);
    if (!current || current.status !== 'QUARANTINED') {
      const error = new Error('Document is not eligible for clean release'); error.code = 'DOCUMENT_RELEASE_CONFLICT'; throw error;
    }
    const next = freezeClone({ ...current, status:'ACTIVE', scanStatus:'CLEAN', scanResult:'CLEAN', scannerEngine:scannerEngine || null, scannerVersion:scannerVersion || null, releasedAt });
    this.documents.set(documentId, next);
    return next;
  }

  async rejectDocumentAfterScan({ documentId, scanResult, scannerEngine, scannerVersion }) {
    const current = this.documents.get(documentId);
    if (!current || current.status !== 'QUARANTINED') {
      const error = new Error('Document is not eligible for scan rejection'); error.code = 'DOCUMENT_SCAN_STATE_CONFLICT'; throw error;
    }
    const normalized = String(scanResult || '').toUpperCase();
    const next = freezeClone({ ...current, status:'REJECTED', scanStatus:normalized === 'INFECTED' ? 'INFECTED' : 'FAILED', scanResult:normalized, scannerEngine:scannerEngine || null, scannerVersion:scannerVersion || null });
    this.documents.set(documentId, next);
    return next;
  }

  async changeDocumentClassification({ documentId, classification }) {
    const current = this.documents.get(documentId);
    if (!current || current.status === 'WITHDRAWN') { const error = new Error('Document classification cannot be changed'); error.code='DOCUMENT_STATE_CONFLICT'; throw error; }
    const next = freezeClone({ ...current, classification }); this.documents.set(documentId, next); return next;
  }

  async supersedeDocument({ documentId, replacementDocumentId }) {
    const current = this.documents.get(documentId);
    const replacement = this.documents.get(replacementDocumentId);
    if (!current || !replacement || current.status !== 'ACTIVE' || replacement.status !== 'ACTIVE' || current.filingId !== replacement.filingId || current.courtId !== replacement.courtId || current.documentId === replacement.documentId) {
      const error = new Error('Document replacement is not eligible to supersede this version'); error.code='DOCUMENT_SUPERSEDE_CONFLICT'; throw error;
    }
    const next = freezeClone({ ...current, status:'SUPERSEDED', supersededByDocumentId:replacementDocumentId }); this.documents.set(documentId, next); return next;
  }

  async withdrawDocument({ documentId, actorSubject, reason, at }) {
    const current = this.documents.get(documentId);
    if (!current || ['WITHDRAWN','SUPERSEDED','ARCHIVED'].includes(current.status)) { const error = new Error('Document cannot be withdrawn from its current state'); error.code='DOCUMENT_WITHDRAW_CONFLICT'; throw error; }
    const next = freezeClone({ ...current, status:'WITHDRAWN', withdrawnAt:at, withdrawnBySubject:actorSubject, withdrawalReason:reason }); this.documents.set(documentId, next); return next;
  }
}

module.exports = {
  createDocumentRuntime,
  MemoryDocumentScanStore,
  MemorySecureDocumentRepository
};
