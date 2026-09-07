'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('0013 extends document lifecycle with private immutable storage evidence', () => {
  const sql = read('db/migrations/0013_secure_document_pipeline.sql');

  assert.match(sql, /BEGIN;/i);
  assert.match(sql, /storage_object_key/i);
  assert.match(sql, /version_number/i);
  assert.match(sql, /prior_document_id/i);
  assert.match(sql, /superseded_by_document_id/i);
  assert.match(sql, /expected_size_bytes/i);
  assert.match(sql, /detected_mime_type/i);
  assert.match(sql, /file_policy_result/i);
  assert.match(sql, /scan_status/i);
  assert.match(sql, /released_at/i);
  assert.match(sql, /legal_hold/i);
  assert.match(sql, /disposition_eligible_at/i);
  assert.match(sql, /UPLOAD_PENDING/i);
  assert.match(sql, /QUARANTINED/i);
  assert.match(sql, /ACTIVE/i);
  assert.match(sql, /REJECTED/i);
  assert.match(sql, /SUPERSEDED/i);
  assert.match(sql, /WITHDRAWN/i);
  assert.match(sql, /COMMIT;/i);
});

test('0013 prevents finalized storage identity and integrity evidence from being rewritten', () => {
  const sql = read('db/migrations/0013_secure_document_pipeline.sql');

  assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+documents\.enforce_document_byte_immutability/i);
  assert.match(sql, /OLD\.finalized_at\s+IS\s+NOT\s+NULL/i);
  assert.match(sql, /NEW\.storage_object_key\s+IS\s+DISTINCT\s+FROM\s+OLD\.storage_object_key/i);
  assert.match(sql, /NEW\.checksum_sha256\s+IS\s+DISTINCT\s+FROM\s+OLD\.checksum_sha256/i);
  assert.match(sql, /NEW\.size_bytes\s+IS\s+DISTINCT\s+FROM\s+OLD\.size_bytes/i);
  assert.match(sql, /NEW\.detected_mime_type\s+IS\s+DISTINCT\s+FROM\s+OLD\.detected_mime_type/i);
  assert.match(sql, /CREATE\s+TRIGGER\s+documents_bytes_immutable_trg/i);
  assert.match(sql, /BEFORE\s+UPDATE\s+ON\s+documents\.documents/i);
});

test('0013 creates a dedicated leased malware scan queue with bounded retry state', () => {
  const sql = read('db/migrations/0013_secure_document_pipeline.sql');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS documents\.scan_jobs/i);
  assert.match(sql, /scan_job_id/i);
  assert.match(sql, /UNIQUE\s*\(document_id\)/i);
  assert.match(sql, /attempt_count/i);
  assert.match(sql, /max_attempts/i);
  assert.match(sql, /next_attempt_at/i);
  assert.match(sql, /lease_owner/i);
  assert.match(sql, /lease_expires_at/i);
  assert.match(sql, /PENDING/i);
  assert.match(sql, /LEASED/i);
  assert.match(sql, /SUCCEEDED/i);
  assert.match(sql, /FAILED_RETRYABLE/i);
  assert.match(sql, /DEAD_LETTER/i);
  assert.match(sql, /CHECK\s*\(attempt_count\s*>=\s*0\)/i);
  assert.match(sql, /CHECK\s*\(max_attempts\s*>=\s*1\)/i);
});

test('0013 prevents self-linking and provides due-job/object-key indexes', () => {
  const sql = read('db/migrations/0013_secure_document_pipeline.sql');

  assert.match(sql, /prior_document_id\s+IS\s+NULL\s+OR\s+prior_document_id\s*<>\s*document_id/i);
  assert.match(sql, /superseded_by_document_id\s+IS\s+NULL\s+OR\s+superseded_by_document_id\s*<>\s*document_id/i);
  assert.match(sql, /scan_jobs_due_idx/i);
  assert.match(sql, /storage_object_key/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+documents\.documents/i);
});

test('isolated Supabase 0013 mirrors document and scan-job controls without touching live schemas', () => {
  const sql = read('db/supabase/20260907_dciecms_test_0013.sql');

  assert.match(sql, /dciecms_test\.documents/i);
  assert.match(sql, /dciecms_test\.document_scan_jobs/i);
  assert.match(sql, /storage_object_key/i);
  assert.match(sql, /legal_hold/i);
  assert.match(sql, /lease_owner/i);
  assert.match(sql, /DEAD_LETTER/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE\s+documents\.documents/i);
  assert.doesNotMatch(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+documents\.scan_jobs/i);
});
