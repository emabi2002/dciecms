'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '../../db/supabase/20260906_dciecms_test_0011.sql');

test('Supabase test profile provisions R3 durable idempotency and actor-subject audit controls', () => {
  assert.equal(fs.existsSync(migrationPath), true, '20260906_dciecms_test_0011.sql must exist');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dciecms_test\.workflow_idempotency_records/i);
  assert.match(sql, /UNIQUE\s*\(\s*actor_subject\s*,\s*operation\s*,\s*resource_id\s*,\s*idempotency_key\s*\)/i);
  assert.match(sql, /ALTER TABLE dciecms_test\.audit_events[\s\S]*ADD COLUMN IF NOT EXISTS actor_subject\s+text/i);
});
