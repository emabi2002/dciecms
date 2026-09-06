'use strict';

const SCAN_JOB_COLUMNS = `scan_job_id, document_id, status, attempt_count,
  max_attempts, next_attempt_at, lease_owner, lease_expires_at,
  scanner_engine, scanner_version, result_code, last_error_code,
  created_at, updated_at, completed_at`;

function mapScanJob(row) {
  if (!row) return null;
  return Object.freeze({
    scanJobId: row.scan_job_id,
    documentId: row.document_id,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 0),
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at || null,
    scannerEngine: row.scanner_engine || null,
    scannerVersion: row.scanner_version || null,
    resultCode: row.result_code || null,
    lastErrorCode: row.last_error_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  });
}

function requiredText(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function isoTime(value, name) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return date.toISOString();
}

function ownershipConflict() {
  const error = new Error('Scan job is not leased by this worker');
  error.code = 'SCAN_JOB_OWNERSHIP_CONFLICT';
  return error;
}

function scanRetryDelayMs(attemptNumber, baseMs = 30000, capMs = 3600000) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) throw new TypeError('attemptNumber must be a positive integer');
  if (!Number.isInteger(baseMs) || baseMs < 1) throw new TypeError('baseMs must be a positive integer');
  if (!Number.isInteger(capMs) || capMs < baseMs) throw new TypeError('capMs must be an integer at least baseMs');
  return Math.min(capMs, baseMs * (2 ** (attemptNumber - 1)));
}

class PostgresDocumentScanStore {
  constructor(queryable) {
    if (!queryable || typeof queryable.query !== 'function') {
      throw new TypeError('PostgresDocumentScanStore requires a pg-compatible queryable');
    }
    this.db = queryable;
  }

  async getByDocumentId(documentId) {
    const id = requiredText(documentId, 'documentId');
    const result = await this.db.query(`SELECT ${SCAN_JOB_COLUMNS}
      FROM documents.scan_jobs
      WHERE document_id=$1`, [id]);
    return mapScanJob(result.rows[0]);
  }

  async claimDue({ workerId, limit = 10, leaseSeconds = 60, now = new Date().toISOString() } = {}) {
    const owner = requiredText(workerId, 'workerId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer between 1 and 100');
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new TypeError('leaseSeconds must be an integer between 1 and 3600');
    const nowIso = isoTime(now, 'now');
    const leaseExpiresAt = new Date(Date.parse(nowIso) + leaseSeconds * 1000).toISOString();

    const result = await this.db.query(`WITH candidates AS (
      SELECT scan_job_id AS candidate_id
      FROM documents.scan_jobs
      WHERE (status IN ('PENDING','FAILED_RETRYABLE') AND next_attempt_at <= $1::timestamptz)
         OR (status='LEASED' AND lease_expires_at <= $1::timestamptz)
      ORDER BY next_attempt_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $2
    )
    UPDATE documents.scan_jobs AS jobs
    SET status='LEASED',
        lease_owner=$3,
        lease_expires_at=$4::timestamptz,
        updated_at=$1::timestamptz
    FROM candidates
    WHERE jobs.scan_job_id=candidates.candidate_id
    RETURNING ${SCAN_JOB_COLUMNS}`, [nowIso, limit, owner, leaseExpiresAt]);

    return result.rows.map(mapScanJob);
  }

  async markClean({ scanJobId, workerId, engine, version, completedAt = new Date().toISOString() } = {}) {
    return this.#markCompleted({ scanJobId, workerId, engine, version, resultCode:'CLEAN', completedAt });
  }

  async markInfected({ scanJobId, workerId, engine, version, completedAt = new Date().toISOString() } = {}) {
    return this.#markCompleted({ scanJobId, workerId, engine, version, resultCode:'INFECTED', completedAt });
  }

  async #markCompleted({ scanJobId, workerId, engine, version, resultCode, completedAt }) {
    const id = requiredText(scanJobId, 'scanJobId');
    const owner = requiredText(workerId, 'workerId');
    const at = isoTime(completedAt, 'completedAt');
    const result = await this.db.query(`UPDATE documents.scan_jobs
      SET status='SUCCEEDED',
          scanner_engine=$3,
          scanner_version=$4,
          result_code='${resultCode}',
          last_error_code=NULL,
          lease_owner=NULL,
          lease_expires_at=NULL,
          updated_at=$5::timestamptz,
          completed_at=$5::timestamptz
      WHERE scan_job_id=$1 AND status='LEASED' AND lease_owner=$2
      RETURNING ${SCAN_JOB_COLUMNS}`, [id, owner, engine || null, version || null, at]);
    if (result.rows.length !== 1) throw ownershipConflict();
    return mapScanJob(result.rows[0]);
  }

  async markRetryableFailure({ scanJobId, workerId, errorCode, nextAttemptAt, attemptedAt = new Date().toISOString() } = {}) {
    const id = requiredText(scanJobId, 'scanJobId');
    const owner = requiredText(workerId, 'workerId');
    const code = requiredText(errorCode, 'errorCode');
    const retryAt = isoTime(nextAttemptAt, 'nextAttemptAt');
    const at = isoTime(attemptedAt, 'attemptedAt');

    const result = await this.db.query(`UPDATE documents.scan_jobs
      SET attempt_count=attempt_count+1,
          last_error_code=$3,
          result_code='ERROR_RETRYABLE',
          status=CASE WHEN attempt_count+1 >= max_attempts THEN 'DEAD_LETTER' ELSE 'FAILED_RETRYABLE' END,
          next_attempt_at=CASE WHEN attempt_count+1 >= max_attempts THEN next_attempt_at ELSE $4::timestamptz END,
          lease_owner=NULL,
          lease_expires_at=NULL,
          updated_at=$5::timestamptz,
          completed_at=CASE WHEN attempt_count+1 >= max_attempts THEN $5::timestamptz ELSE NULL END
      WHERE scan_job_id=$1 AND status='LEASED' AND lease_owner=$2
      RETURNING ${SCAN_JOB_COLUMNS}`, [id, owner, code, retryAt, at]);
    if (result.rows.length !== 1) throw ownershipConflict();
    return mapScanJob(result.rows[0]);
  }

  async markPermanentFailure({ scanJobId, workerId, resultCode, completedAt = new Date().toISOString() } = {}) {
    const id = requiredText(scanJobId, 'scanJobId');
    const owner = requiredText(workerId, 'workerId');
    const code = requiredText(resultCode, 'resultCode').toUpperCase();
    const at = isoTime(completedAt, 'completedAt');
    if (!['UNSUPPORTED','ERROR_PERMANENT'].includes(code)) throw new TypeError('resultCode must be UNSUPPORTED or ERROR_PERMANENT');

    const result = await this.db.query(`UPDATE documents.scan_jobs
      SET status='DEAD_LETTER',
          attempt_count=attempt_count+1,
          result_code=$3,
          last_error_code=$3,
          lease_owner=NULL,
          lease_expires_at=NULL,
          updated_at=$4::timestamptz,
          completed_at=$4::timestamptz
      WHERE scan_job_id=$1 AND status='LEASED' AND lease_owner=$2
      RETURNING ${SCAN_JOB_COLUMNS}`, [id, owner, code, at]);
    if (result.rows.length !== 1) throw ownershipConflict();
    return mapScanJob(result.rows[0]);
  }

  async retryDeadLetter({ scanJobId, nextAttemptAt = new Date().toISOString() } = {}) {
    const id = requiredText(scanJobId, 'scanJobId');
    const at = isoTime(nextAttemptAt, 'nextAttemptAt');
    const result = await this.db.query(`UPDATE documents.scan_jobs
      SET status='PENDING',
          attempt_count=0,
          next_attempt_at=$2::timestamptz,
          lease_owner=NULL,
          lease_expires_at=NULL,
          result_code=NULL,
          last_error_code=NULL,
          updated_at=$2::timestamptz,
          completed_at=NULL
      WHERE scan_job_id=$1 AND status='DEAD_LETTER'
      RETURNING ${SCAN_JOB_COLUMNS}`, [id, at]);
    if (result.rows.length !== 1) {
      const error = new Error('Scan job is not in dead-letter state');
      error.code = 'SCAN_JOB_STATE_CONFLICT';
      throw error;
    }
    return mapScanJob(result.rows[0]);
  }
}

module.exports = {
  PostgresDocumentScanStore,
  mapScanJob,
  scanRetryDelayMs
};
