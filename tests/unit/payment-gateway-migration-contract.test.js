'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SUPABASE_TEST_TABLES } = require('../../services/api/src/postgres-schema-mapping');

const root = path.resolve(__dirname, '../..');
const logicalPath = path.join(root, 'db/migrations/0014_payment_gateway_callbacks.sql');
const supabasePath = path.join(root, 'db/supabase/20260907_dciecms_test_0014.sql');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('0014 creates a durable payment callback inbox with replay-safe provider event identity', () => {
  const sql = read(logicalPath);

  assert.match(sql, /BEGIN\s*;/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS finance\.payment_gateway_callbacks/i);
  assert.match(sql, /callback_id\s+uuid\s+PRIMARY KEY/i);
  assert.match(sql, /provider_event_id/i);
  assert.match(sql, /payload_digest_sha256/i);
  assert.match(sql, /UNIQUE\s*\(\s*provider\s*,\s*provider_event_id\s*\)/i);
  assert.match(sql, /PAYMENT_SUCCEEDED/);
  assert.match(sql, /PAYMENT_FAILED/);
  assert.match(sql, /RECEIVED/);
  assert.match(sql, /PROCESSING/);
  assert.match(sql, /APPLIED/);
  assert.match(sql, /IGNORED/);
  assert.match(sql, /REJECTED/);
  assert.match(sql, /CHECK\s*\(\s*amount_minor\s*>=\s*0\s*\)/i);
  assert.match(sql, /COMMIT\s*;/i);
});

test('0014 stores only a SHA-256 payload digest rather than unrestricted callback transport evidence', () => {
  const sql = read(logicalPath);

  assert.match(sql, /payload_digest_sha256\s+char\(64\)\s+NOT NULL/i);
  assert.match(sql, /\^\[a-f0-9\]\{64\}\$/i);
  assert.doesNotMatch(sql, /raw_payload|raw_body|signature_value|authorization_header/i);
});

test('isolated Supabase 0014 mirrors the callback inbox only inside dciecms_test', () => {
  const sql = read(supabasePath);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS dciecms_test\.finance_payment_gateway_callbacks/i);
  assert.match(sql, /REFERENCES dciecms_test\.finance_payments\(payment_id\)/i);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS finance\.payment_gateway_callbacks/i);
  assert.doesNotMatch(sql, /public\.|auth\.|storage\./i);
});

test('Supabase SQL mapping rewrites the logical R6 callback inbox table', () => {
  assert.equal(
    SUPABASE_TEST_TABLES['finance.payment_gateway_callbacks'],
    'dciecms_test.finance_payment_gateway_callbacks'
  );
});
