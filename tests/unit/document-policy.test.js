'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateDocumentIntent,
  validateAuthoritativeObject
} = require('../../services/api/src/document-policy');

test('document intent accepts supported PDF and normalizes metadata', () => {
  const value = validateDocumentIntent({
    fileName: 'claim.PDF',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    classification: 'confidential'
  });

  assert.equal(value.fileName, 'claim.PDF');
  assert.equal(value.extension, '.pdf');
  assert.equal(value.mimeType, 'application/pdf');
  assert.equal(value.sizeBytes, 1024);
  assert.equal(value.classification, 'CONFIDENTIAL');
});

test('document intent defaults classification to CONFIDENTIAL', () => {
  const value = validateDocumentIntent({
    fileName: 'claim.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 5
  });
  assert.equal(value.classification, 'CONFIDENTIAL');
});

test('document intent blocks executable and archive types', () => {
  assert.throws(
    () => validateDocumentIntent({ fileName:'payload.exe', mimeType:'application/octet-stream', sizeBytes:100 }),
    /not allowed/i
  );
  assert.throws(
    () => validateDocumentIntent({ fileName:'bundle.zip', mimeType:'application/zip', sizeBytes:100 }),
    /not allowed/i
  );
});

test('document intent rejects oversize and zero-byte files', () => {
  assert.throws(
    () => validateDocumentIntent(
      { fileName:'huge.pdf', mimeType:'application/pdf', sizeBytes:20 },
      { maxSizeBytes:10 }
    ),
    /size/i
  );
  assert.throws(
    () => validateDocumentIntent({ fileName:'empty.pdf', mimeType:'application/pdf', sizeBytes:0 }),
    /size/i
  );
});

test('document intent rejects extension and declared mime mismatch', () => {
  assert.throws(
    () => validateDocumentIntent({ fileName:'claim.pdf', mimeType:'image/png', sizeBytes:5 }),
    /mime/i
  );
});

test('authoritative evidence accepts exact size checksum and detected type', () => {
  const intent = validateDocumentIntent({ fileName:'claim.pdf', mimeType:'application/pdf', sizeBytes:5 });
  const evidence = validateAuthoritativeObject(intent, {
    sizeBytes: 5,
    checksumSha256: 'a'.repeat(64),
    detectedMimeType: 'application/pdf'
  });

  assert.equal(evidence.sizeBytes, 5);
  assert.equal(evidence.checksumSha256, 'a'.repeat(64));
  assert.equal(evidence.detectedMimeType, 'application/pdf');
});

test('authoritative evidence rejects size mismatch', () => {
  const intent = validateDocumentIntent({ fileName:'claim.pdf', mimeType:'application/pdf', sizeBytes:5 });
  assert.throws(
    () => validateAuthoritativeObject(intent, {
      sizeBytes: 6,
      checksumSha256: 'a'.repeat(64),
      detectedMimeType: 'application/pdf'
    }),
    /size/i
  );
});

test('authoritative evidence rejects invalid checksum and detected content mismatch', () => {
  const intent = validateDocumentIntent({ fileName:'claim.pdf', mimeType:'application/pdf', sizeBytes:5 });
  assert.throws(
    () => validateAuthoritativeObject(intent, {
      sizeBytes: 5,
      checksumSha256: 'bad',
      detectedMimeType: 'application/pdf'
    }),
    /sha-256/i
  );
  assert.throws(
    () => validateAuthoritativeObject(intent, {
      sizeBytes: 5,
      checksumSha256: 'a'.repeat(64),
      detectedMimeType: 'application/x-msdownload'
    }),
    /content type/i
  );
});

test('document intent rejects unknown classification', () => {
  assert.throws(
    () => validateDocumentIntent({ fileName:'claim.pdf', mimeType:'application/pdf', sizeBytes:5, classification:'SECRETISH' }),
    /classification/i
  );
});
