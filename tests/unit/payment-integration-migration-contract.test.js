'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('0014 adds server-controlled provider binding and durable provider event evidence', () => {
  const sql = read('db/migrations/0014_payment_integration_hardening.sql');

  assert.match(sql, /ALTER\s+TABLE\s+finance\.payments/i);
  assert.match(sql, /provider_code/i);
  assert.match(sql, /provider_payment_reference/i);
  assert.match(sql, /provider_status/i);
  assert.match(sql, /session_created_at/i);
  assert.match(sql, /provider_confirmed_at/i);
  assert.match(sql, /failure_code/i);
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+finance\.payment_provider_events/i);
  assert.match(sql, /provider_event_id/i);
  assert.match(sql, /normalized_event_type/i);
  assert.match(sql, /payment_id/i);
  assert.match(sql, /amount_minor/i);
  assert.match(sql, /currency/i);
  assert.match(sql, /processing_status/i);
  assert.match(sql, /attempt_count/i);
  assert.match(sql, /next_attempt_at/i);
  assert.match(sql, /lease_owner/i);
  assert.match(sql, /lease_expires_at/i);
  assert.match(sql, /UNIQUE\s*\(provider_code\s*,\s*provider_event_id\)/i);
});

test('0014 constrains provider event vocabulary and provider reference rewrites', () => {
  const sql = read('db/migrations/0014_payment_integration_hardening.sql');

  assert.match(sql, /PAYMENT_SUCCEEDED/i);
  assert.match(sql, /PAYMENT_FAILED/i);
  assert.match(sql, /PAYMENT_CANCELLED/i);
  assert.match(sql, /PAYMENT_REFUNDED/i);
  assert.match(sql, /PAYMENT_REVERSED/i);
  assert.match(sql, /RECEIVED/i);
  assert.match(sql, /PROCESSING/i);
  assert.match(sql, /PROCESSED/i);
  assert.match(sql, /REJECTED/i);
  assert.match(sql, /DEAD_LETTER/i);
  assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+finance\.enforce_payment_provider_binding_immutability/i);
  assert.match(sql, /provider_payment_reference/i);
  assert.match(sql, /provider_code/i);
  assert.match(sql, /CREATE\s+TRIGGER\s+payment_provider_binding_immutable_trg/i);
});

test('0014 creates provider event processing and payment lookup indexes without raw secret columns', () => {
  const sql = read('db/migrations/0014_payment_integration_hardening.sql');

  assert.match(sql, /payment_provider_events_due_idx/i);
  assert.match(sql, /payments_provider_reference/i);
  assert.doesNotMatch(sql, /\braw_signature\b/i);
  assert.doesNotMatch(sql, /\bwebhook_secret\b/i);
  assert.doesNotMatch(sql, /\bapi_key\b/i);
  assert.doesNotMatch(sql, /\bcheckout_token\b/i);
});

test('isolated Supabase 0014 mirrors provider evidence only inside dciecms_test', () => {
  const sql = read('db/supabase/20260907_dciecms_test_0014.sql');

  assert.match(sql, /dciecms_test\.finance_payments/i);
  assert.match(sql, /dciecms_test\.finance_payment_provider_events/i);
  assert.match(sql, /provider_payment_reference/i);
  assert.match(sql, /provider_event_id/i);
  assert.match(sql, /PAYMENT_SUCCEEDED/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE\s+finance\.payments/i);
  assert.doesNotMatch(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+finance\.payment_provider_events/i);
});

test('Supabase test schema mapping includes the payment provider event inbox', () => {
  const { SUPABASE_TEST_TABLES, rewriteSql } = require('../../services/api/src/postgres-schema-mapping');

  assert.equal(
    SUPABASE_TEST_TABLES['finance.payment_provider_events'],
    'dciecms_test.finance_payment_provider_events'
  );
  assert.equal(
    rewriteSql('SELECT * FROM finance.payment_provider_events', 'supabase_test'),
    'SELECT * FROM dciecms_test.finance_payment_provider_events'
  );
});
