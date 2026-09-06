'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function loadFinanceRepository() {
  try {
    return require('../../services/api/src/finance-operations-postgres-repository').FinanceOperationsPostgresRepository;
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' && String(error.message).includes('finance-operations-postgres-repository')) return null;
    throw error;
  }
}

class FakeQueryable {
  constructor(rows = []) { this.rows = rows; this.calls = []; }
  async query(text, params = []) { this.calls.push({ text, params }); return { rows: this.rows }; }
}

const COURT_A='11111111-1111-1111-1111-111111111111';
const PAYMENT_ROW = {
  payment_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', assessment_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', court_id:COURT_A,
  amount_minor:'12500', currency:'PGK', status:'PENDING', provider_reference:null, created_by_subject:'fin-a', created_at:'2026-09-06T06:00:00.000Z', confirmed_by_subject:null, confirmed_at:null
};
const RECEIPT_ROW = {
  receipt_id:'dddddddd-dddd-dddd-dddd-dddddddddddd', receipt_number:'RCT-0001', payment_id:PAYMENT_ROW.payment_id, court_id:COURT_A,
  amount_minor:'12500', currency:'PGK', status:'ISSUED', issued_by_subject:'fin-a', issued_at:'2026-09-06T06:03:00.000Z'
};
const RECONCILIATION_ROW = {
  reconciliation_id:'cccccccc-cccc-cccc-cccc-cccccccccccc', payment_id:PAYMENT_ROW.payment_id, court_id:COURT_A, status:'CERTIFIED',
  prepared_by_subject:'fin-a', prepared_at:'2026-09-06T06:05:00.000Z', certified_by_subject:'fin-mgr-a', certified_at:'2026-09-06T06:10:00.000Z'
};

test('R3 finance repository extends the existing repository chain',()=>{
  const FinanceOperationsPostgresRepository=loadFinanceRepository();
  assert.equal(typeof FinanceOperationsPostgresRepository,'function');
});

test('finance queue is parameterized and constrained to supplied court scopes',async()=>{
  const Repo=loadFinanceRepository(), db=new FakeQueryable([PAYMENT_ROW]), repo=new Repo(db);
  const rows=await repo.listFinanceQueue({courtIds:[COURT_A],status:null});
  assert.equal(rows.length,1); assert.equal(rows[0].paymentId,PAYMENT_ROW.payment_id); assert.equal(rows[0].amountMinor,12500);
  assert.match(db.calls[0].text,/FROM finance\.payments/i); assert.match(db.calls[0].text,/court_id = ANY\(\$1::uuid\[\]\)/i);
  assert.deepEqual(db.calls[0].params,[[COURT_A]]);
});

test('finance queue applies status as a bound parameter',async()=>{
  const Repo=loadFinanceRepository(), db=new FakeQueryable([{...PAYMENT_ROW,status:'CONFIRMED'}]), repo=new Repo(db);
  const rows=await repo.listFinanceQueue({courtIds:[COURT_A],status:'CONFIRMED'});
  assert.equal(rows[0].status,'CONFIRMED'); assert.match(db.calls[0].text,/status = \$2/i); assert.equal(db.calls[0].text.includes('CONFIRMED'),false);
  assert.deepEqual(db.calls[0].params,[[COURT_A],'CONFIRMED']);
});

test('finance repository reads reconciliation evidence by payment using a bound identifier',async()=>{
  const Repo=loadFinanceRepository(), db=new FakeQueryable([RECONCILIATION_ROW]), repo=new Repo(db);
  const row=await repo.getReconciliationByPayment(PAYMENT_ROW.payment_id);
  assert.equal(row.reconciliationId,RECONCILIATION_ROW.reconciliation_id); assert.equal(row.paymentId,PAYMENT_ROW.payment_id);
  assert.match(db.calls[0].text,/FROM finance\.reconciliations/i); assert.match(db.calls[0].text,/payment_id=\$1/i); assert.deepEqual(db.calls[0].params,[PAYMENT_ROW.payment_id]);
});

test('receipt queue is court-scoped and status-filtered with bound parameters',async()=>{
  const Repo=loadFinanceRepository(), db=new FakeQueryable([RECEIPT_ROW]), repo=new Repo(db);
  const rows=await repo.listReceipts({courtIds:[COURT_A],status:'ISSUED'});
  assert.equal(rows[0].receiptId,RECEIPT_ROW.receipt_id); assert.match(db.calls[0].text,/FROM finance\.receipts/i);
  assert.match(db.calls[0].text,/court_id = ANY\(\$1::uuid\[\]\)/i); assert.match(db.calls[0].text,/status = \$2/i);
  assert.equal(db.calls[0].text.includes('ISSUED'),false); assert.deepEqual(db.calls[0].params,[[COURT_A],'ISSUED']);
});

test('reconciliation queue is court-scoped and status-filtered with bound parameters',async()=>{
  const Repo=loadFinanceRepository(), db=new FakeQueryable([RECONCILIATION_ROW]), repo=new Repo(db);
  const rows=await repo.listReconciliations({courtIds:[COURT_A],status:'CERTIFIED'});
  assert.equal(rows[0].reconciliationId,RECONCILIATION_ROW.reconciliation_id); assert.match(db.calls[0].text,/FROM finance\.reconciliations/i);
  assert.match(db.calls[0].text,/court_id = ANY\(\$1::uuid\[\]\)/i); assert.match(db.calls[0].text,/status = \$2/i);
  assert.equal(db.calls[0].text.includes('CERTIFIED'),false); assert.deepEqual(db.calls[0].params,[[COURT_A],'CERTIFIED']);
});
