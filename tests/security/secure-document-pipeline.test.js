'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { resolveActorFromClaims } = require('../../packages/auth');
const { createHttpApp } = require('../../services/api/src/http-app');
const { SecureDocumentService } = require('../../services/api/src/secure-document-service');
const { isDocumentDispositionEligible } = require('../../services/api/src/document-policy');

function actor({ sub = 'public-a', roles = ['PUBLIC'], courts = ['COURT-A'], grants = [] } = {}) {
  return resolveActorFromClaims({ sub, roles, court_ids: courts, explicit_grants: grants });
}

function securityFixture() {
  const filings = new Map([
    ['F-OWN', { filingId: 'F-OWN', courtId: 'COURT-A', createdBy: 'public-a', status: 'DRAFT' }],
    ['F-OTHER', { filingId: 'F-OTHER', courtId: 'COURT-A', createdBy: 'public-b', status: 'DRAFT' }]
  ]);
  const documents = new Map();
  const auditEvents = [];
  let sequence = 0;
  const repository = {
    async getFiling(id) { return filings.get(id) || null; },
    async getDocument(id) { return documents.get(id) || null; },
    async createDocumentUploadIntent(input) {
      const document = {
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
        versionNumber: input.versionNumber || 1,
        priorDocumentId: input.priorDocumentId || null,
        expectedSizeBytes: input.expectedSizeBytes,
        createdBySubject: input.actorSubject,
        finalizedAt: null,
        scanStatus: 'NOT_REQUESTED',
        releasedAt: null,
        legalHold: false
      };
      documents.set(document.documentId, document);
      return Object.freeze({ ...document });
    }
  };
  const storage = {
    capabilities() { return { privateObjects: true, encryptionAtRest: true }; },
    async createUploadGrant({ objectKey, expiresAt }) {
      return { objectKey, expiresAt, uploadUrl: `https://private.example/upload?token=signed-upload-token` };
    },
    async headObject({ objectKey }) {
      return { objectKey, sizeBytes: 12, checksumSha256: 'a'.repeat(64), detectedMimeType: 'application/pdf' };
    },
    async createDownloadGrant({ objectKey, expiresAt }) {
      return { objectKey, expiresAt, downloadUrl: `https://private.example/download?token=signed-download-token` };
    }
  };
  const auditStore = {
    async append(event) { auditEvents.push(Object.freeze({ ...event })); return auditEvents.at(-1); }
  };
  const service = new SecureDocumentService({
    repository,
    storage,
    auditStore,
    uuid: () => `DOC-${++sequence}`,
    clock: () => new Date('2026-09-07T00:00:00.000Z')
  });
  return { filings, documents, auditEvents, service };
}

function activeDocument(overrides = {}) {
  return {
    documentId: 'DOC-A',
    filingId: 'F-OWN',
    courtId: 'COURT-A',
    fileName: 'claim.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 12,
    checksumSha256: 'a'.repeat(64),
    status: 'ACTIVE',
    classification: 'CONFIDENTIAL',
    storageObjectKey: 'quarantine/COURT-A/DOC-A/claim.pdf',
    versionNumber: 1,
    releasedAt: '2026-09-07T00:00:00.000Z',
    legalHold: false,
    dispositionEligibleAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  };
}

async function withHttpService(service, fn) {
  const handler = createHttpApp(service, () => actor({ roles: ['REG-MGR'] }));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('signed upload and download grants remain ephemeral and never enter document metadata or audit evidence', async () => {
  const { service, documents, auditEvents } = securityFixture();
  const upload = await service.initiateDocumentUpload(actor(), 'F-OWN', {
    fileName: 'claim.pdf', mimeType: 'application/pdf', sizeBytes: 12, classification: 'CONFIDENTIAL'
  });
  assert.equal(upload.uploadGrant.uploadUrl.includes('signed-upload-token'), true);
  assert.equal(JSON.stringify(upload.document).includes('signed-upload-token'), false);
  assert.equal(JSON.stringify(documents.get(upload.document.documentId)).includes('signed-upload-token'), false);
  assert.equal(JSON.stringify(auditEvents).includes('signed-upload-token'), false);

  documents.set('DOC-A', activeDocument());
  const download = await service.authorizeDocumentDownload(actor(), 'DOC-A');
  assert.equal(download.downloadGrant.downloadUrl.includes('signed-download-token'), true);
  assert.equal(JSON.stringify(documents.get('DOC-A')).includes('signed-download-token'), false);
  assert.equal(JSON.stringify(auditEvents).includes('signed-download-token'), false);
});

test('caller cannot choose storage key and normal document service exposes no hard-delete method', async () => {
  const { service } = securityFixture();
  await assert.rejects(
    () => service.initiateDocumentUpload(actor(), 'F-OWN', {
      fileName: 'claim.pdf', mimeType: 'application/pdf', sizeBytes: 12,
      objectKey: 'other-court/secret.pdf'
    }),
    /object key|storage/i
  );
  assert.equal(typeof service.deleteDocument, 'undefined');
});

test('unprivileged uploader cannot downgrade initial document classification', async () => {
  const { service } = securityFixture();
  await assert.rejects(
    () => service.initiateDocumentUpload(actor(), 'F-OWN', {
      fileName: 'claim.pdf', mimeType: 'application/pdf', sizeBytes: 12, classification: 'PUBLIC'
    }),
    /classification|permission/i
  );
  await assert.doesNotReject(
    () => service.initiateDocumentUpload(actor({ sub: 'reg-mgr-a', roles: ['REG-MGR'] }), 'F-OWN', {
      fileName: 'court-notice.pdf', mimeType: 'application/pdf', sizeBytes: 12, classification: 'PUBLIC'
    })
  );
});

test('ordinary download remains fail-closed for quarantined, superseded, withdrawn and restricted-without-grant records', async () => {
  const { service, documents } = securityFixture();
  for (const status of ['QUARANTINED', 'SUPERSEDED', 'WITHDRAWN']) {
    documents.set(`DOC-${status}`, activeDocument({ documentId: `DOC-${status}`, status }));
    await assert.rejects(() => service.authorizeDocumentDownload(actor(), `DOC-${status}`), /active|released/i);
  }
  documents.set('DOC-R', activeDocument({ documentId: 'DOC-R', classification: 'RESTRICTED' }));
  await assert.rejects(() => service.authorizeDocumentDownload(actor(), 'DOC-R'), /explicit grant/i);
});

test('PUBLIC actors cannot authorize another filer\'s document even when both records are in the same court', async () => {
  const { service, documents } = securityFixture();
  documents.set('DOC-OTHER', activeDocument({ documentId: 'DOC-OTHER', filingId: 'F-OTHER' }));
  await assert.rejects(
    () => service.authorizeDocumentDownload(actor({ sub: 'public-a' }), 'DOC-OTHER'),
    /filing relationship|record relationship|owner/i
  );
});

test('INTERNAL classification excludes PUBLIC-only actors even for their own filing', async () => {
  const { service, documents } = securityFixture();
  documents.set('DOC-INTERNAL', activeDocument({ documentId: 'DOC-INTERNAL', classification: 'INTERNAL' }));
  await assert.rejects(
    () => service.authorizeDocumentDownload(actor({ sub: 'public-a', roles: ['PUBLIC'] }), 'DOC-INTERNAL'),
    /internal|access denied|permission/i
  );
  await assert.doesNotReject(
    () => service.authorizeDocumentDownload(actor({ sub: 'reg-a', roles: ['REG'] }), 'DOC-INTERNAL')
  );
});

test('legacy metadata-only document registration route is not exposed by the secure HTTP boundary', async () => {
  let called = false;
  const service = {
    async registerDocument() {
      called = true;
      return { documentId: 'LEGACY-1', status: 'QUARANTINED' };
    }
  };
  await withHttpService(service, async base => {
    const response = await fetch(`${base}/filings/F-OWN/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: 'bypass.pdf',
        mimeType: 'application/pdf',
        checksumSha256: 'a'.repeat(64)
      })
    });
    assert.equal(response.status, 404);
    assert.equal(called, false);
  });
});

test('legal hold is an unconditional governed-disposition veto', () => {
  const eligible = activeDocument({ status: 'ARCHIVED', legalHold: false, dispositionEligibleAt: '2026-09-01T00:00:00.000Z' });
  assert.equal(isDocumentDispositionEligible(eligible, { at: '2026-09-07T00:00:00.000Z' }), true);
  assert.equal(isDocumentDispositionEligible({ ...eligible, legalHold: true }, { at: '2026-09-07T00:00:00.000Z' }), false);
  assert.equal(isDocumentDispositionEligible({ ...eligible, dispositionEligibleAt: '2026-10-01T00:00:00.000Z' }, { at: '2026-09-07T00:00:00.000Z' }), false);
});

test('provider and scanner diagnostics are sanitized at the HTTP boundary', async () => {
  const sentinel = 'scanner-token=super-secret-provider-key';
  const service = { async retryDocumentScan() { throw new Error(sentinel); } };
  await withHttpService(service, async base => {
    const response = await fetch(`${base}/documents/DOC-A/retry-scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.equal(text.includes(sentinel), false);
    assert.equal(text.includes('super-secret-provider-key'), false);
  });
});
