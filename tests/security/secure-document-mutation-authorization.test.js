'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveActorFromClaims } = require('../../packages/auth');
const { MemoryDocumentStorage } = require('../../services/api/src/document-storage');
const { SecureDocumentService } = require('../../services/api/src/secure-document-service');

function actor({ grants = [] } = {}) {
  return resolveActorFromClaims({
    sub: 'reg-mgr-a',
    roles: ['REG-MGR'],
    court_ids: ['COURT-A'],
    explicit_grants: grants
  });
}

function fixture() {
  const filings = new Map([['F-1', { filingId: 'F-1', courtId: 'COURT-A', createdBy: 'owner-a', status: 'DRAFT' }]]);
  const documents = new Map();
  let sequence = 0;
  const repository = {
    async getFiling(id) { return filings.get(id) || null; },
    async getDocument(id) { return documents.get(id) || null; },
    async createDocumentUploadIntent(input) {
      const document = Object.freeze({
        documentId: input.documentId,
        filingId: input.filingId,
        courtId: input.courtId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        status: 'UPLOAD_PENDING',
        classification: input.classification,
        storageObjectKey: input.storageObjectKey,
        expectedSizeBytes: input.expectedSizeBytes,
        versionNumber: input.versionNumber || 1,
        priorDocumentId: input.priorDocumentId || null
      });
      documents.set(document.documentId, document);
      return document;
    },
    async changeDocumentClassification({ documentId, classification }) {
      const next = Object.freeze({ ...documents.get(documentId), classification });
      documents.set(documentId, next);
      return next;
    },
    async withdrawDocument({ documentId, actorSubject, reason, at }) {
      const next = Object.freeze({ ...documents.get(documentId), status: 'WITHDRAWN', withdrawnBySubject: actorSubject, withdrawalReason: reason, withdrawnAt: at });
      documents.set(documentId, next);
      return next;
    },
    async supersedeDocument({ documentId, replacementDocumentId }) {
      const next = Object.freeze({ ...documents.get(documentId), status: 'SUPERSEDED', supersededByDocumentId: replacementDocumentId });
      documents.set(documentId, next);
      return next;
    }
  };
  const scanStore = {
    async getByDocumentId(documentId) {
      return { scanJobId: `SCAN-${documentId}`, documentId, status: 'DEAD_LETTER' };
    },
    async retryDeadLetter({ scanJobId }) {
      return { scanJobId, status: 'PENDING' };
    }
  };
  const auditStore = { async append(event) { return event; } };
  const service = new SecureDocumentService({
    repository,
    storage: new MemoryDocumentStorage(),
    auditStore,
    scanStore,
    uuid: () => `DOC-${++sequence}`,
    clock: () => new Date('2026-09-07T00:00:00.000Z')
  });
  return { service, documents };
}

function activeDocument(overrides = {}) {
  return Object.freeze({
    documentId: 'DOC-A',
    filingId: 'F-1',
    courtId: 'COURT-A',
    fileName: 'record.pdf',
    mimeType: 'application/pdf',
    status: 'ACTIVE',
    classification: 'CONFIDENTIAL',
    storageObjectKey: 'quarantine/COURT-A/DOC-A/record.pdf',
    versionNumber: 1,
    releasedAt: '2026-09-07T00:00:00.000Z',
    ...overrides
  });
}

test('assigning SEALED or RESTRICTED at upload requires the corresponding explicit authority', async () => {
  for (const [classification, grant] of [['SEALED', 'document.sealed.view'], ['RESTRICTED', 'document.restricted.view']]) {
    const denied = fixture();
    await assert.rejects(
      () => denied.service.initiateDocumentUpload(actor(), 'F-1', {
        fileName: 'record.pdf', mimeType: 'application/pdf', sizeBytes: 12, classification
      }),
      /explicit grant/i
    );

    const allowed = fixture();
    await assert.doesNotReject(() => allowed.service.initiateDocumentUpload(actor({ grants: [grant] }), 'F-1', {
      fileName: 'record.pdf', mimeType: 'application/pdf', sizeBytes: 12, classification
    }));
  }
});

test('classification change cannot assign SEALED without sealed-document authority', async () => {
  const { service, documents } = fixture();
  documents.set('DOC-A', activeDocument());
  await assert.rejects(
    () => service.changeDocumentClassification(actor(), 'DOC-A', { classification: 'SEALED', reason: 'court direction' }),
    /explicit grant/i
  );
  await assert.doesNotReject(() => service.changeDocumentClassification(actor({ grants: ['document.sealed.view'] }), 'DOC-A', {
    classification: 'SEALED', reason: 'court direction'
  }));
});

test('SEALED document cannot be withdrawn without sealed-document authority', async () => {
  const { service, documents } = fixture();
  documents.set('DOC-S', activeDocument({ documentId: 'DOC-S', classification: 'SEALED' }));
  await assert.rejects(() => service.withdrawDocument(actor(), 'DOC-S', 'court direction'), /explicit grant/i);
});

test('SEALED document cannot be superseded without sealed-document authority', async () => {
  const { service, documents } = fixture();
  documents.set('DOC-S', activeDocument({ documentId: 'DOC-S', classification: 'SEALED' }));
  documents.set('DOC-R', activeDocument({
    documentId: 'DOC-R',
    classification: 'SEALED',
    versionNumber: 2,
    priorDocumentId: 'DOC-S'
  }));
  await assert.rejects(() => service.supersedeDocument(actor(), 'DOC-S', 'DOC-R', 'replacement'), /explicit grant/i);
});

test('SEALED document scan retry cannot bypass sealed-document authority', async () => {
  const { service, documents } = fixture();
  documents.set('DOC-S', activeDocument({ documentId: 'DOC-S', status: 'QUARANTINED', releasedAt: null, classification: 'SEALED' }));
  await assert.rejects(() => service.retryDocumentScan(actor(), 'DOC-S'), /explicit grant/i);
});
