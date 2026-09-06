'use strict';

const DOCUMENT_COLUMNS = `document_id, filing_id, court_id, file_name, mime_type,
  size_bytes, checksum_sha256, status, classification, created_at,
  storage_object_key, version_number, prior_document_id, superseded_by_document_id,
  expected_size_bytes, detected_mime_type, created_by_subject,
  finalized_at, finalized_by_subject, file_policy_result, file_policy_code,
  scan_status, scan_result, scanner_engine, scanner_version, released_at,
  withdrawn_at, withdrawn_by_subject, withdrawal_reason,
  legal_hold, legal_hold_reference, disposition_eligible_at`;

function mapSecureDocument(row) {
  if (!row) return null;
  return Object.freeze({
    documentId: row.document_id,
    filingId: row.filing_id,
    courtId: row.court_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    checksumSha256: row.checksum_sha256 || null,
    status: row.status,
    classification: row.classification,
    createdAt: row.created_at,
    storageObjectKey: row.storage_object_key || null,
    versionNumber: Number(row.version_number || 1),
    priorDocumentId: row.prior_document_id || null,
    supersededByDocumentId: row.superseded_by_document_id || null,
    expectedSizeBytes: row.expected_size_bytes == null ? null : Number(row.expected_size_bytes),
    detectedMimeType: row.detected_mime_type || null,
    createdBySubject: row.created_by_subject || null,
    finalizedAt: row.finalized_at || null,
    finalizedBySubject: row.finalized_by_subject || null,
    filePolicyResult: row.file_policy_result || 'NOT_CHECKED',
    filePolicyCode: row.file_policy_code || null,
    scanStatus: row.scan_status || 'NOT_REQUESTED',
    scanResult: row.scan_result || null,
    scannerEngine: row.scanner_engine || null,
    scannerVersion: row.scanner_version || null,
    releasedAt: row.released_at || null,
    withdrawnAt: row.withdrawn_at || null,
    withdrawnBySubject: row.withdrawn_by_subject || null,
    withdrawalReason: row.withdrawal_reason || null,
    legalHold: row.legal_hold === true,
    legalHoldReference: row.legal_hold_reference || null,
    dispositionEligibleAt: row.disposition_eligible_at || null
  });
}

function stateConflict(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameFinalization(document, input) {
  return Boolean(document) &&
    document.finalizedAt &&
    document.sizeBytes === Number(input.sizeBytes) &&
    document.checksumSha256 === String(input.checksumSha256 || '').toLowerCase() &&
    document.detectedMimeType === String(input.detectedMimeType || '').toLowerCase();
}

function installSecureDocumentRepository(PostgresRepository) {
  if (!PostgresRepository || !PostgresRepository.prototype) {
    throw new TypeError('PostgresRepository constructor is required');
  }
  const proto = PostgresRepository.prototype;
  if (proto.__secureDocumentRepositoryInstalled) return;

  Object.defineProperty(proto, '__secureDocumentRepositoryInstalled', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  proto.createDocumentUploadIntent = async function createDocumentUploadIntent({
    documentId,
    filingId,
    courtId,
    fileName,
    mimeType,
    expectedSizeBytes,
    classification,
    storageObjectKey,
    actorSubject,
    versionNumber = 1,
    priorDocumentId = null
  }) {
    const result = await this.db.query(`INSERT INTO documents.documents (
      document_id, filing_id, court_id, file_name, mime_type, size_bytes,
      checksum_sha256, status, classification, storage_object_key,
      version_number, prior_document_id, expected_size_bytes, created_by_subject,
      file_policy_result, scan_status
    ) VALUES ($1,$2,$3,$4,$5,0,NULL,'UPLOAD_PENDING',$6,$7,$8,$9,$10,$11,'NOT_CHECKED','NOT_REQUESTED')
    RETURNING ${DOCUMENT_COLUMNS}`, [
      documentId, filingId, courtId, fileName, mimeType, classification,
      storageObjectKey, versionNumber, priorDocumentId, expectedSizeBytes, actorSubject
    ]);
    return mapSecureDocument(result.rows[0]);
  };

  proto.getDocument = async function getDocument(documentId) {
    const result = await this.db.query(`SELECT ${DOCUMENT_COLUMNS}
      FROM documents.documents WHERE document_id=$1`, [documentId]);
    return mapSecureDocument(result.rows[0]);
  };

  proto.finalizeDocumentAndCreateScanJob = async function finalizeDocumentAndCreateScanJob({
    documentId,
    scanJobId,
    actorSubject,
    sizeBytes,
    checksumSha256,
    detectedMimeType,
    finalizedAt,
    maxAttempts = 5
  }) {
    if (typeof this.db.connect !== 'function') {
      throw new TypeError('finalizeDocumentAndCreateScanJob requires a pool with connect()');
    }
    const client = await this.db.connect();
    const checksum = String(checksumSha256 || '').toLowerCase();
    const detected = String(detectedMimeType || '').toLowerCase();
    try {
      await client.query('BEGIN');
      const updated = await client.query(`UPDATE documents.documents
        SET size_bytes=$2,
            checksum_sha256=$3,
            detected_mime_type=$4,
            finalized_at=$5,
            finalized_by_subject=$6,
            file_policy_result='PASSED',
            file_policy_code=NULL,
            status='QUARANTINED',
            scan_status='PENDING'
        WHERE document_id=$1 AND status='UPLOAD_PENDING'
        RETURNING ${DOCUMENT_COLUMNS}`, [
        documentId, Number(sizeBytes), checksum, detected, finalizedAt, actorSubject
      ]);

      if (updated.rows.length === 0) {
        const existing = await client.query(`SELECT ${DOCUMENT_COLUMNS}
          FROM documents.documents WHERE document_id=$1 FOR UPDATE`, [documentId]);
        const canonical = mapSecureDocument(existing.rows[0]);
        if (!sameFinalization(canonical, { sizeBytes, checksumSha256: checksum, detectedMimeType: detected })) {
          throw stateConflict('DOCUMENT_FINALIZE_CONFLICT', 'Document finalization conflicts with canonical evidence');
        }
        await client.query('COMMIT');
        return canonical;
      }

      await client.query(`INSERT INTO documents.scan_jobs (
        scan_job_id, document_id, status, max_attempts, next_attempt_at
      ) VALUES ($1,$2,'PENDING',$3,$4)
      ON CONFLICT (document_id) DO NOTHING`, [scanJobId, documentId, maxAttempts, finalizedAt]);
      await client.query('COMMIT');
      return mapSecureDocument(updated.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  };

  proto.activateCleanDocument = async function activateCleanDocument({
    documentId,
    scannerEngine,
    scannerVersion,
    releasedAt
  }) {
    const result = await this.db.query(`UPDATE documents.documents
      SET status='ACTIVE',
          scan_status='CLEAN',
          scan_result='CLEAN',
          scanner_engine=$2,
          scanner_version=$3,
          released_at=$4
      WHERE document_id=$1 AND status='QUARANTINED'
      RETURNING ${DOCUMENT_COLUMNS}`, [documentId, scannerEngine || null, scannerVersion || null, releasedAt]);
    if (result.rows.length !== 1) throw stateConflict('DOCUMENT_RELEASE_CONFLICT', 'Document is not eligible for clean release');
    return mapSecureDocument(result.rows[0]);
  };

  proto.rejectDocumentAfterScan = async function rejectDocumentAfterScan({
    documentId,
    scanResult,
    scannerEngine,
    scannerVersion
  }) {
    const normalized = String(scanResult || '').toUpperCase();
    const scanStatus = normalized === 'INFECTED' ? 'INFECTED' : 'FAILED';
    const result = await this.db.query(`UPDATE documents.documents
      SET status='REJECTED',
          scan_status=$2,
          scan_result=$3,
          scanner_engine=$4,
          scanner_version=$5
      WHERE document_id=$1 AND status='QUARANTINED'
      RETURNING ${DOCUMENT_COLUMNS}`, [documentId, scanStatus, normalized, scannerEngine || null, scannerVersion || null]);
    if (result.rows.length !== 1) throw stateConflict('DOCUMENT_SCAN_STATE_CONFLICT', 'Document is not eligible for scan rejection');
    return mapSecureDocument(result.rows[0]);
  };

  proto.changeDocumentClassification = async function changeDocumentClassification({ documentId, classification }) {
    const result = await this.db.query(`UPDATE documents.documents
      SET classification=$2
      WHERE document_id=$1 AND status <> 'WITHDRAWN'
      RETURNING ${DOCUMENT_COLUMNS}`, [documentId, classification]);
    if (result.rows.length !== 1) throw stateConflict('DOCUMENT_STATE_CONFLICT', 'Document classification cannot be changed');
    return mapSecureDocument(result.rows[0]);
  };

  proto.supersedeDocument = async function supersedeDocument({ documentId, replacementDocumentId }) {
    const result = await this.db.query(`UPDATE documents.documents AS original
      SET status='SUPERSEDED', superseded_by_document_id=$2
      WHERE original.document_id=$1
        AND original.status='ACTIVE'
        AND EXISTS (
          SELECT 1 FROM documents.documents replacement
          WHERE replacement.document_id=$2
            AND replacement.filing_id=original.filing_id
            AND replacement.court_id=original.court_id
            AND replacement.status='ACTIVE'
            AND replacement.document_id <> original.document_id
        )
      RETURNING ${DOCUMENT_COLUMNS}`, [documentId, replacementDocumentId]);
    if (result.rows.length !== 1) throw stateConflict('DOCUMENT_SUPERSEDE_CONFLICT', 'Document replacement is not eligible to supersede this version');
    return mapSecureDocument(result.rows[0]);
  };

  proto.withdrawDocument = async function withdrawDocument({ documentId, actorSubject, reason, at }) {
    const result = await this.db.query(`UPDATE documents.documents
      SET status='WITHDRAWN',
          withdrawn_at=$4,
          withdrawn_by_subject=$2,
          withdrawal_reason=$3
      WHERE document_id=$1
        AND status NOT IN ('WITHDRAWN','SUPERSEDED','ARCHIVED')
      RETURNING ${DOCUMENT_COLUMNS}`, [documentId, actorSubject, reason, at]);
    if (result.rows.length !== 1) throw stateConflict('DOCUMENT_WITHDRAW_CONFLICT', 'Document cannot be withdrawn from its current state');
    return mapSecureDocument(result.rows[0]);
  };
}

module.exports = {
  DOCUMENT_COLUMNS,
  mapSecureDocument,
  installSecureDocumentRepository
};
