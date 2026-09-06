'use strict';

class DocumentStorageContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocumentStorageContractError';
  }
}

function assertFunction(target, name) {
  if (!target || typeof target[name] !== 'function') {
    throw new DocumentStorageContractError(`Document storage must expose ${name}()`);
  }
}

function assertDocumentStorage(storage, { production = false } = {}) {
  assertFunction(storage, 'createUploadGrant');
  assertFunction(storage, 'headObject');
  assertFunction(storage, 'createDownloadGrant');
  assertFunction(storage, 'capabilities');

  const capabilities = storage.capabilities();
  if (!capabilities || typeof capabilities !== 'object') {
    throw new DocumentStorageContractError('Document storage capabilities() must return an object');
  }

  if (production) {
    if (capabilities.developmentOnly === true) {
      throw new DocumentStorageContractError('Development-only document storage cannot be used in production');
    }
    if (capabilities.privateObjects !== true || capabilities.encryptionAtRest !== true) {
      throw new DocumentStorageContractError('Production document storage requires private objects and encryption at rest');
    }
  }

  return storage;
}

function requireObjectKey(value) {
  const objectKey = String(value || '').trim();
  if (!objectKey) throw new DocumentStorageContractError('A storage objectKey is required');
  return objectKey;
}

function requireExpiry(value) {
  const expiresAt = String(value || '').trim();
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    throw new DocumentStorageContractError('A valid grant expiry is required');
  }
  return expiresAt;
}

class MemoryDocumentStorage {
  constructor() {
    this.objects = new Map();
  }

  capabilities() {
    return Object.freeze({
      privateObjects: true,
      encryptionAtRest: false,
      developmentOnly: true
    });
  }

  async createUploadGrant({ objectKey, expiresAt } = {}) {
    const key = requireObjectKey(objectKey);
    const expiry = requireExpiry(expiresAt);
    return Object.freeze({
      objectKey: key,
      expiresAt: expiry,
      uploadUrl: `memory://upload/${key}?expires=${encodeURIComponent(expiry)}`
    });
  }

  putObjectMetadata(metadata = {}) {
    const objectKey = requireObjectKey(metadata.objectKey);
    const value = Object.freeze({
      objectKey,
      sizeBytes: Number(metadata.sizeBytes),
      checksumSha256: String(metadata.checksumSha256 || '').trim(),
      detectedMimeType: String(metadata.detectedMimeType || '').trim().toLowerCase()
    });
    this.objects.set(objectKey, value);
    return value;
  }

  async headObject({ objectKey } = {}) {
    const key = requireObjectKey(objectKey);
    const value = this.objects.get(key);
    if (!value) throw new DocumentStorageContractError('Document object not found');
    return Object.freeze({ ...value });
  }

  async createDownloadGrant({ objectKey, expiresAt } = {}) {
    const key = requireObjectKey(objectKey);
    const expiry = requireExpiry(expiresAt);
    return Object.freeze({
      objectKey: key,
      expiresAt: expiry,
      downloadUrl: `memory://download/${key}?expires=${encodeURIComponent(expiry)}`
    });
  }
}

module.exports = {
  DocumentStorageContractError,
  assertDocumentStorage,
  MemoryDocumentStorage
};
