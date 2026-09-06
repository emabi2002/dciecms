'use strict';

const path = require('node:path');
const { authorize } = require('../../../packages/rbac');

const DEFAULT_DOCUMENT_POLICY = Object.freeze({
  maxSizeBytes: 25 * 1024 * 1024,
  types: Object.freeze({
    '.pdf': Object.freeze(['application/pdf']),
    '.doc': Object.freeze(['application/msword']),
    '.docx': Object.freeze(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
    '.xls': Object.freeze(['application/vnd.ms-excel']),
    '.xlsx': Object.freeze(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
    '.jpg': Object.freeze(['image/jpeg']),
    '.jpeg': Object.freeze(['image/jpeg']),
    '.png': Object.freeze(['image/png'])
  }),
  classifications: Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SEALED'])
});

class DocumentPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocumentPolicyError';
    this.statusCode = 422;
  }
}

function resolvePolicy(overrides = {}) {
  const maxSizeBytes = overrides.maxSizeBytes ?? DEFAULT_DOCUMENT_POLICY.maxSizeBytes;
  const types = overrides.types ?? DEFAULT_DOCUMENT_POLICY.types;
  const classifications = overrides.classifications ?? DEFAULT_DOCUMENT_POLICY.classifications;
  return { maxSizeBytes, types, classifications };
}

function normalizeMimeType(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeClassification(value) {
  return String(value || 'CONFIDENTIAL').trim().toUpperCase();
}

function validateDocumentIntent(input, policyOverrides = {}) {
  const policy = resolvePolicy(policyOverrides);
  const fileName = String(input?.fileName || '').trim();
  if (!fileName || fileName.includes('\0')) throw new DocumentPolicyError('A valid fileName is required');

  const extension = path.extname(fileName).toLowerCase();
  const allowedMimes = policy.types[extension];
  if (!allowedMimes) throw new DocumentPolicyError(`File type is not allowed: ${extension || 'unknown'}`);

  const mimeType = normalizeMimeType(input?.mimeType);
  if (!allowedMimes.includes(mimeType)) throw new DocumentPolicyError('Declared MIME type does not match the allowed file type');

  const sizeBytes = Number(input?.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > policy.maxSizeBytes) {
    throw new DocumentPolicyError(`Document size must be between 1 and ${policy.maxSizeBytes} bytes`);
  }

  const classification = normalizeClassification(input?.classification);
  if (!policy.classifications.includes(classification)) throw new DocumentPolicyError('Document classification is not allowed');

  return Object.freeze({ fileName, extension, mimeType, sizeBytes, classification });
}

function validateAuthoritativeObject(intent, evidence, policyOverrides = {}) {
  const policy = resolvePolicy(policyOverrides);
  if (!intent || !intent.extension) throw new DocumentPolicyError('Validated document intent is required');

  const sizeBytes = Number(evidence?.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes !== intent.sizeBytes) {
    throw new DocumentPolicyError('Authoritative object size does not match the upload intent');
  }

  const checksumSha256 = String(evidence?.checksumSha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksumSha256)) throw new DocumentPolicyError('Authoritative checksum must be a SHA-256 hex digest');

  const detectedMimeType = normalizeMimeType(evidence?.detectedMimeType);
  const allowedMimes = policy.types[intent.extension] || [];
  if (!allowedMimes.includes(detectedMimeType)) {
    throw new DocumentPolicyError('Detected content type does not match the allowed file type');
  }

  return Object.freeze({ sizeBytes, checksumSha256, detectedMimeType });
}

function authorizeDocumentClassification(actor, document, operation = 'view') {
  if (operation !== 'view') throw new DocumentPolicyError(`Unsupported classification authorization operation: ${operation}`);
  const classification = normalizeClassification(document?.classification);
  if (!DEFAULT_DOCUMENT_POLICY.classifications.includes(classification)) {
    throw new DocumentPolicyError('Document classification is not allowed');
  }

  let explicitGrant;
  if (classification === 'RESTRICTED') explicitGrant = 'document.restricted.view';
  if (classification === 'SEALED') explicitGrant = 'document.sealed.view';

  authorize(actor, 'document.view', {
    courtId: document?.courtId,
    ...(explicitGrant ? { explicitGrant } : {})
  });
  return true;
}

module.exports = {
  DEFAULT_DOCUMENT_POLICY,
  DocumentPolicyError,
  validateDocumentIntent,
  validateAuthoritativeObject,
  authorizeDocumentClassification
};
