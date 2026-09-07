'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMappedDatabase } = require('../../services/api/src/postgres-schema-mapping');

const migrationPath = path.join(__dirname, '../../db/supabase/20260907_dciecms_test_0015.sql');

test('isolated Supabase 0015 mirrors case lifecycle and records controls only inside dciecms_test', () => {
  assert.equal(fs.existsSync(migrationPath), true, 'isolated Supabase migration 0015 must exist');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /ALTER TABLE dciecms_test\.cases/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dciecms_test\.case_lifecycle_events/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dciecms_test\.case_record_controls/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dciecms_test\.records_disposal_requests/i);
  assert.match(sql, /REFERENCES dciecms_test\.cases\(case_id\)/i);
  assert.match(sql, /REFERENCES dciecms_test\.config_courts\(court_id\)/i);
  assert.match(sql, /REFERENCES dciecms_test\.judicial_judgments\(judgment_id\)/i);
  assert.match(sql, /REVOKE DELETE ON dciecms_test\.case_lifecycle_events FROM PUBLIC/i);
  assert.match(sql, /REVOKE DELETE ON dciecms_test\.case_record_controls FROM PUBLIC/i);
  assert.match(sql, /REVOKE DELETE ON dciecms_test\.records_disposal_requests FROM PUBLIC/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION dciecms_test\.enforce_case_lifecycle_event_immutability\(\)/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON dciecms_test\.case_lifecycle_events/i);

  assert.doesNotMatch(sql, /CREATE SCHEMA\s+records/i);
  assert.doesNotMatch(sql, /ALTER TABLE\s+case_mgmt\./i);
  assert.doesNotMatch(sql, /CREATE TABLE[^\n]+\srecords\./i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i);
  assert.doesNotMatch(sql, /DROP TABLE/i);
});

test('Supabase test mapping rewrites every case lifecycle and records repository table', async () => {
  const seen = [];
  const db = {
    async query(text, params) {
      seen.push({ text, params });
      return { rows: [] };
    }
  };
  const mapped = createMappedDatabase(db, 'supabase_test');
  await mapped.query(`SELECT *
    FROM case_mgmt.case_lifecycle_events e
    JOIN records.case_record_controls rc ON rc.case_id=e.case_id
    JOIN records.disposal_requests dr ON dr.case_record_control_id=rc.case_record_control_id
    WHERE e.case_id=$1`, ['case-1']);

  assert.match(seen[0].text, /FROM dciecms_test\.case_lifecycle_events e/i);
  assert.match(seen[0].text, /JOIN dciecms_test\.case_record_controls rc/i);
  assert.match(seen[0].text, /JOIN dciecms_test\.records_disposal_requests dr/i);
  assert.doesNotMatch(seen[0].text, /case_mgmt\.case_lifecycle_events/i);
  assert.doesNotMatch(seen[0].text, /records\.case_record_controls/i);
  assert.doesNotMatch(seen[0].text, /records\.disposal_requests/i);
  assert.deepEqual(seen[0].params, ['case-1']);
});
