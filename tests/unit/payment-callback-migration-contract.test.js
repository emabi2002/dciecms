'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rewriteSql } = require('../../services/api/src/postgres-schema-mapping');

const logicalPath = path.join(__dirname, '../../db/migrations/0014_payment_callback_security.sql');
const testProfilePath = path.join(__dirname, '../../db/supabase/20260907_dciecms_test_0014.sql');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('0014 binds payments to a provider and creates normalized durable callback replay evidence', () => {
  const sql = read(logicalPath);

  assert.match(sql, /BEGIN;/i);
  assert.match(sql, /ALTER TABLE finance\.payments[\s\S]*provider_code/i);
  assert.match(sql, /provider_code[\s\S]*\^\[a-z0-9\]/i);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS integration/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS integration\.payment_callback_events/i);
  assert.match(sql, /provider_event_id varchar\(180\) NOT NULL/i);
  assert.match(sql, /payment_id uuid NOT NULL REFERENCES finance\.payments\(payment_id\)/i);
  assert.match(sql, /body_sha256 char\(64\) NOT NULL/i);
  assert.match(sql, /provider_reference varchar\(160\) NOT NULL/i);
  assert.match(sql, /event_status varchar\(30\) NOT NULL/i);
  assert.match(sql, /processing_status varchar\(30\) NOT NULL DEFAULT 'RECEIVED'/i);
  assert.match(sql, /UNIQUE\s*\(provider_code,\s*provider_event_id\)/i);
  assert.match(sql, /CHECK\s*\(event_status\s*=\s*'CONFIRMED'\)/i);
  assert.match(sql, /CHECK\s*\(processing_status IN \('RECEIVED','PROCESSED'\)\)/i);
  assert.match(sql, /REVOKE DELETE ON integration\.payment_callback_events FROM PUBLIC/i);
  assert.match(sql, /COMMIT;/i);

  assert.doesNotMatch(sql, /raw_body/i);
  assert.doesNotMatch(sql, /signature_value/i);
  assert.doesNotMatch(sql, /authorization_header/i);
  assert.doesNotMatch(sql, /shared_secret/i);
});

test('isolated Supabase 0014 mirrors callback controls only inside dciecms_test', () => {
  const sql = read(testProfilePath);

  assert.match(sql, /ALTER TABLE dciecms_test\.finance_payments[\s\S]*provider_code/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dciecms_test\.payment_callback_events/i);
  assert.match(sql, /REFERENCES dciecms_test\.finance_payments\(payment_id\)/i);
  assert.match(sql, /REVOKE DELETE ON dciecms_test\.payment_callback_events FROM PUBLIC/i);
  assert.doesNotMatch(sql, /ALTER TABLE public\./i);
  assert.doesNotMatch(sql, /ALTER TABLE auth\./i);
  assert.doesNotMatch(sql, /ALTER TABLE storage\./i);
});

test('Supabase test SQL mapping rewrites durable callback rows into isolated physical table', () => {
  const sql = rewriteSql(
    'SELECT * FROM integration.payment_callback_events WHERE payment_id=$1',
    'supabase_test'
  );
  assert.equal(sql, 'SELECT * FROM dciecms_test.payment_callback_events WHERE payment_id=$1');
});
