'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertDocumentStorage,
  MemoryDocumentStorage
} = require('../../services/api/src/document-storage');

function insecureStorage() {
  return {
    createUploadGrant: async () => ({}),
    headObject: async () => ({}),
    createDownloadGrant: async () => ({}),
    capabilities: () => ({ privateObjects:false, encryptionAtRest:false, developmentOnly:false })
  };
}

test('document storage contract requires upload, head, download and capability methods', () => {
  assert.throws(
    () => assertDocumentStorage({}, { production:false }),
    /createUploadGrant/i
  );
});

test('production storage must attest private objects and encryption at rest', () => {
  assert.throws(
    () => assertDocumentStorage(insecureStorage(), { production:true }),
    /private.*encryption|encryption.*private/i
  );
});

test('development memory storage cannot be accepted as production storage', () => {
  assert.throws(
    () => assertDocumentStorage(new MemoryDocumentStorage(), { production:true }),
    /development/i
  );
});

test('memory storage issues short-lived object-bound upload grants for development tests', async () => {
  const storage = new MemoryDocumentStorage();
  assert.doesNotThrow(() => assertDocumentStorage(storage, { production:false }));

  const grant = await storage.createUploadGrant({
    objectKey:'quarantine/COURT-A/doc-1/claim.pdf',
    contentType:'application/pdf',
    sizeBytes:5,
    expiresAt:'2026-09-07T00:05:00.000Z',
    encryptionRequired:true
  });

  assert.equal(grant.objectKey, 'quarantine/COURT-A/doc-1/claim.pdf');
  assert.equal(grant.expiresAt, '2026-09-07T00:05:00.000Z');
  assert.equal(typeof grant.uploadUrl, 'string');
  assert.equal(grant.uploadUrl.includes('quarantine/COURT-A/doc-1/claim.pdf'), true);
});

test('memory storage returns only authoritative metadata previously recorded by trusted test setup', async () => {
  const storage = new MemoryDocumentStorage();
  storage.putObjectMetadata({
    objectKey:'quarantine/COURT-A/doc-1/claim.pdf',
    sizeBytes:5,
    checksumSha256:'a'.repeat(64),
    detectedMimeType:'application/pdf'
  });

  const metadata = await storage.headObject({ objectKey:'quarantine/COURT-A/doc-1/claim.pdf' });
  assert.deepEqual(metadata, {
    objectKey:'quarantine/COURT-A/doc-1/claim.pdf',
    sizeBytes:5,
    checksumSha256:'a'.repeat(64),
    detectedMimeType:'application/pdf'
  });
});

test('memory storage download grant is bound to one exact private object key', async () => {
  const storage = new MemoryDocumentStorage();
  const grant = await storage.createDownloadGrant({
    objectKey:'active/COURT-A/doc-1/claim.pdf',
    fileName:'claim.pdf',
    contentType:'application/pdf',
    expiresAt:'2026-09-07T00:05:00.000Z'
  });

  assert.equal(grant.objectKey, 'active/COURT-A/doc-1/claim.pdf');
  assert.equal(grant.expiresAt, '2026-09-07T00:05:00.000Z');
  assert.equal(typeof grant.downloadUrl, 'string');
});
