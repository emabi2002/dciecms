'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMappedDatabase } = require('../../services/api/src/postgres-schema-mapping');

const migrationPath = path.join(__dirname, '../../db/supabase/20260907_dciecms_test_0016.sql');

test('isolated Supabase 0016 mirrors finance completion only inside dciecms_test', () => {
  assert.equal(fs.existsSync(migrationPath), true, 'isolated Supabase migration 0016 must exist');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS dciecms_test\.finance_fee_schedules/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dciecms_test\.finance_payment_adjustments/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dciecms_test\.finance_refund_requests/i);
  assert.match(sql, /ALTER TABLE dciecms_test\.finance_fee_assessments/i);
  assert.match(sql, /ALTER TABLE dciecms_test\.finance_payments/i);
  assert.match(sql, /ALTER TABLE dciecms_test\.finance_reconciliations/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION dciecms_test\.prevent_issued_receipt_mutation\(\)/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON dciecms_test\.finance_receipts/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION dciecms_test\.prevent_finalized_reconciliation_mutation\(\)/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON dciecms_test\.finance_reconciliations/i);
  assert.match(sql, /REVOKE DELETE ON dciecms_test\.finance_refund_requests FROM PUBLIC/i);

  assert.doesNotMatch(sql, /CREATE SCHEMA\s+finance/i);
  assert.doesNotMatch(sql, /\bfinance\.(?!prevent_)/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i);
  assert.doesNotMatch(sql, /DROP TABLE/i);
});

test('Supabase test mapping rewrites every R3 finance completion repository table', async () => {
  const seen = [];
  const db = {
    async query(text, params) {
      seen.push({ text, params });
      return { rows: [] };
    }
  };
  const mapped = createMappedDatabase(db, 'supabase_test');
  await mapped.query(`SELECT *
    FROM finance.fee_schedules fs
    JOIN finance.payment_adjustments pa ON true
    JOIN finance.refund_requests rr ON true
    JOIN finance.fee_assessments fa ON fa.assessment_id=pa.assessment_id
    JOIN finance.payments p ON p.payment_id=rr.payment_id
    JOIN finance.receipts r ON r.payment_id=p.payment_id
    JOIN finance.reconciliations rec ON rec.payment_id=p.payment_id`, []);

  assert.match(seen[0].text, /FROM dciecms_test\.finance_fee_schedules fs/i);
  assert.match(seen[0].text, /JOIN dciecms_test\.finance_payment_adjustments pa/i);
  assert.match(seen[0].text, /JOIN dciecms_test\.finance_refund_requests rr/i);
  assert.match(seen[0].text, /JOIN dciecms_test\.finance_fee_assessments fa/i);
  assert.match(seen[0].text, /JOIN dciecms_test\.finance_payments p/i);
  assert.match(seen[0].text, /JOIN dciecms_test\.finance_receipts r/i);
  assert.match(seen[0].text, /JOIN dciecms_test\.finance_reconciliations rec/i);
  assert.doesNotMatch(seen[0].text, /finance\.fee_schedules/i);
  assert.doesNotMatch(seen[0].text, /finance\.payment_adjustments/i);
  assert.doesNotMatch(seen[0].text, /finance\.refund_requests/i);
});
