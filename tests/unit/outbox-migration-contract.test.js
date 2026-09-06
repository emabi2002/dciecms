'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rewriteSql } = require('../../services/api/src/postgres-schema-mapping');

const logicalPath = path.join(__dirname, '../../db/migrations/0012_event_outbox.sql');
const supabasePath = path.join(__dirname, '../../db/supabase/20260906_dciecms_test_0012.sql');

test('0012 creates the durable integration outbox contract', () => {
  assert.equal(fs.existsSync(logicalPath), true, '0012_event_outbox.sql must exist');
  const sql = fs.readFileSync(logicalPath, 'utf8');

  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS integration/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS integration\.outbox_events/i);
  assert.match(sql, /event_type\s+varchar\(120\)\s+NOT NULL/i);
  assert.match(sql, /deduplication_key\s+varchar\(240\)\s+NOT NULL/i);
  assert.match(sql, /payload\s+jsonb\s+NOT NULL/i);
  assert.match(sql, /status\s+varchar\(24\)\s+NOT NULL\s+DEFAULT\s+'PENDING'/i);
  assert.match(sql, /attempt_count\s+integer\s+NOT NULL\s+DEFAULT\s+0/i);
  assert.match(sql, /UNIQUE\s*\(\s*event_type\s*,\s*deduplication_key\s*\)/i);
  assert.match(sql, /CHECK\s*\(\s*status\s+IN\s*\(\s*'PENDING'\s*,\s*'PROCESSING'\s*,\s*'DELIVERED'\s*,\s*'DEAD_LETTER'\s*\)\s*\)/i);
  assert.match(sql, /REVOKE\s+DELETE\s+ON\s+integration\.outbox_events\s+FROM\s+PUBLIC/i);
  assert.match(sql, /status\s*,\s*next_attempt_at\s*,\s*created_at/i);
});

test('Supabase isolated profile provisions and maps the R5 outbox table', () => {
  assert.equal(fs.existsSync(supabasePath), true, '20260906_dciecms_test_0012.sql must exist');
  const sql = fs.readFileSync(supabasePath, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dciecms_test\.integration_outbox_events/i);
  assert.match(sql, /UNIQUE\s*\(\s*event_type\s*,\s*deduplication_key\s*\)/i);
  assert.equal(
    rewriteSql('SELECT * FROM integration.outbox_events', 'supabase_test'),
    'SELECT * FROM dciecms_test.integration_outbox_events'
  );
});
