'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PostgresRepository } = require('../../services/api/src/postgres-repository');

const migrationPath = path.join(process.cwd(),'db/migrations/0016_r3_finance_completion.sql');

class CaptureDb {
  constructor(rows = []) { this.rows = rows; this.calls = []; }
  async query(text, params = []) { this.calls.push({ text, params }); return { rows: this.rows }; }
}

test('migration 0016 adds fee schedules, adjustments, refunds and finalized finance evidence protection', () => {
  const sql = fs.readFileSync(migrationPath,'utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS finance\.fee_schedules/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS finance\.payment_adjustments/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS finance\.refund_requests/i);
  assert.match(sql,/ADD COLUMN IF NOT EXISTS exception_code/i);
  assert.match(sql,/ADD COLUMN IF NOT EXISTS rejection_reason/i);
  assert.match(sql,/CREATE TRIGGER finance_reconciliation_finalized_immutable_trg/i);
  assert.match(sql,/OLD\.status IN \('CERTIFIED','REJECTED'\)/i);
  assert.match(sql,/CREATE OR REPLACE FUNCTION finance\.prevent_issued_receipt_mutation\(\)/i);
  assert.match(sql,/CREATE TRIGGER finance_receipt_issued_immutable_trg/i);
  assert.match(sql,/OLD\.status='ISSUED'/i);
  assert.doesNotMatch(sql,/\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(sql,/\bDELETE\s+FROM\b/i);
});

test('PostgresRepository installs the R3 finance completion persistence API', () => {
  const repo = new PostgresRepository(new CaptureDb());
  for (const method of [
    'createFeeSchedule','listFeeSchedules','getFeeSchedule','activateFeeSchedule','retireFeeSchedule',
    'createPaymentAdjustment','getPaymentAdjustment','approvePaymentAdjustment','rejectPaymentAdjustment',
    'createRefundRequest','getRefundRequest','approveRefundRequest','rejectRefundRequest','completeRefundRequest',
    'rejectReconciliation','listReconciliationExceptions'
  ]) assert.equal(typeof repo[method], 'function', method);
});

test('payment workbench queue minimizes its read model and excludes provider reference', async () => {
  const db = new CaptureDb([{
    payment_id:'p-1',assessment_id:'a-1',court_id:'COURT-A',amount_minor:'1000',currency:'PGK',status:'PENDING',
    refunded_amount_minor:'0',provider_reference:'PROVIDER-SENSITIVE-REF',created_by_subject:'fin-a',
    created_at:'2026-09-07T00:00:00Z',confirmed_by_subject:null,confirmed_at:null
  }]);
  const repo = new PostgresRepository(db);
  const rows = await repo.listFinancePayments({ courtIds:['COURT-A'], status:'PENDING' });
  const { text } = db.calls.at(-1);
  assert.doesNotMatch(text,/provider_reference/i);
  assert.equal('providerReference' in rows[0],false);
});

test('refund request SQL locks canonical payment and enforces cumulative refund ceiling', async () => {
  const db = new CaptureDb();
  const repo = new PostgresRepository(db);
  await assert.rejects(() => repo.createRefundRequest({
    refundRequestId:'r-1', paymentId:'p-1', amountMinor:500, reason:'duplicate payment', actorSubject:'fin-a', at:'2026-09-07T00:00:00Z'
  }), /refund|eligible|conflict/i);
  const { text, params } = db.calls.at(-1);
  assert.match(text,/FOR UPDATE/i);
  assert.match(text,/status='CONFIRMED'/i);
  assert.match(text,/SUM\(/i);
  assert.match(text,/COMPLETED|APPROVED|REQUESTED/i);
  assert.match(text,/<=\s*p\.amount_minor/i);
  assert.deepEqual(params, ['r-1','p-1',500,'duplicate payment','fin-a','2026-09-07T00:00:00Z']);
});

test('refund approval SQL enforces maker-checker and state-conditional decision', async () => {
  const db = new CaptureDb();
  const repo = new PostgresRepository(db);
  await assert.rejects(() => repo.approveRefundRequest({ refundRequestId:'r-1', actorSubject:'mgr-a', decisionReason:'approved', at:'2026-09-07T01:00:00Z' }), /refund|state|conflict/i);
  const { text } = db.calls.at(-1);
  assert.match(text,/status='REQUESTED'/i);
  assert.match(text,/requested_by_subject\s*<>\s*\$2/i);
  assert.match(text,/FOR UPDATE/i);
});

test('adjustment approval cannot rewrite confirmed payment evidence and enforces maker-checker', async () => {
  const db = new CaptureDb();
  const repo = new PostgresRepository(db);
  await assert.rejects(() => repo.approvePaymentAdjustment({ adjustmentId:'a-1', actorSubject:'mgr-a', decisionReason:'approved', at:'2026-09-07T01:00:00Z' }), /adjustment|state|conflict/i);
  const { text } = db.calls.at(-1);
  assert.match(text,/requested_by_subject\s*<>\s*\$2/i);
  assert.match(text,/p\.status IS NULL OR p\.status IN \('PENDING','FAILED','CANCELLED'\)/i);
  assert.doesNotMatch(text,/UPDATE\s+finance\.payments\s+SET\s+amount_minor/i);
});

test('reconciliation rejection is maker-checker, reasoned and only PREPARED rows can transition', async () => {
  const db = new CaptureDb();
  const repo = new PostgresRepository(db);
  await assert.rejects(() => repo.rejectReconciliation({ reconciliationId:'rec-1', actorSubject:'mgr-a', reason:'bank mismatch', exceptionCode:'BANK_MISMATCH', at:'2026-09-07T01:00:00Z' }), /reconciliation|state|conflict/i);
  const { text } = db.calls.at(-1);
  assert.match(text,/status='PREPARED'/i);
  assert.match(text,/prepared_by_subject\s*<>\s*\$2/i);
  assert.match(text,/status='REJECTED'/i);
});
