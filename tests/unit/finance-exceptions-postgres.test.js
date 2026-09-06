'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {FinanceOperationsPostgresRepository}=require('../../services/api/src/finance-operations-postgres-repository');

const COURT_A='11111111-1111-1111-1111-111111111111';
const PAYMENT_ID='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EXCEPTION_ID='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

class FakeQueryable{
  constructor(rows=[]){this.rows=rows;this.calls=[];}
  async query(text,params=[]){this.calls.push({text,params});return {rows:this.rows};}
}

const EXCEPTION_ROW={
  exception_id:EXCEPTION_ID,payment_id:PAYMENT_ID,court_id:COURT_A,
  reason_code:'AMOUNT_MISMATCH',evidence:{expectedAmountMinor:12500,observedAmountMinor:12000},
  status:'OPEN',created_by_subject:'fin-a',created_at:'2026-09-06T06:00:00.000Z',
  resolved_by_subject:null,resolved_at:null,resolution_note:null
};

test('finance exception migration creates append-oriented court-scoped evidence',()=>{
  const migration=fs.readFileSync(path.join(__dirname,'../../db/migrations/0011_finance_operations.sql'),'utf8');
  assert.match(migration,/CREATE TABLE IF NOT EXISTS finance\.payment_exceptions/i);
  assert.match(migration,/reason_code/i);
  assert.match(migration,/status IN \('OPEN','RESOLVED'\)/i);
  assert.match(migration,/created_by_subject/i);
  assert.match(migration,/resolved_by_subject/i);
  assert.match(migration,/resolved_by_subject IS NULL OR resolved_by_subject <> created_by_subject/i);
  assert.match(migration,/REVOKE DELETE ON finance\.payment_exceptions/i);
});

test('provider reference collision lookup uses a bound reference',async()=>{
  const db=new FakeQueryable([{payment_id:PAYMENT_ID,assessment_id:'c'.repeat(8)+'-cccc-cccc-cccc-cccccccccccc',court_id:COURT_A,amount_minor:'12500',currency:'PGK',status:'CONFIRMED',provider_reference:'PROV-1',created_by_subject:'fin-a',created_at:'2026-09-06T06:00:00.000Z'}]);
  const repo=new FinanceOperationsPostgresRepository(db);
  const row=await repo.findPaymentByProviderReference('PROV-1');
  assert.equal(row.paymentId,PAYMENT_ID);
  assert.match(db.calls[0].text,/provider_reference=\$1/i);
  assert.deepEqual(db.calls[0].params,['PROV-1']);
});

test('payment exception creation persists structured evidence with bound parameters',async()=>{
  const db=new FakeQueryable([EXCEPTION_ROW]);
  const repo=new FinanceOperationsPostgresRepository(db);
  const row=await repo.createPaymentException({exceptionId:EXCEPTION_ID,paymentId:PAYMENT_ID,courtId:COURT_A,reasonCode:'AMOUNT_MISMATCH',evidence:{observedAmountMinor:12000},createdBy:'fin-a',createdAt:'2026-09-06T06:00:00.000Z'});
  assert.equal(row.exceptionId,EXCEPTION_ID);
  assert.match(db.calls[0].text,/INSERT INTO finance\.payment_exceptions/i);
  assert.match(db.calls[0].text,/evidence/i);
  assert.equal(db.calls[0].params[3],'AMOUNT_MISMATCH');
});

test('payment exception queue is court-scoped and status-filtered',async()=>{
  const db=new FakeQueryable([EXCEPTION_ROW]);
  const repo=new FinanceOperationsPostgresRepository(db);
  const rows=await repo.listPaymentExceptions({courtIds:[COURT_A],status:'OPEN'});
  assert.equal(rows[0].exceptionId,EXCEPTION_ID);
  assert.match(db.calls[0].text,/court_id = ANY\(\$1::uuid\[\]\)/i);
  assert.match(db.calls[0].text,/status = \$2/i);
  assert.deepEqual(db.calls[0].params,[[COURT_A],'OPEN']);
});

test('exception resolution is conditional on OPEN state and different maker/checker actors',async()=>{
  const db=new FakeQueryable([{...EXCEPTION_ROW,status:'RESOLVED',resolved_by_subject:'fin-mgr',resolved_at:'2026-09-06T07:00:00.000Z',resolution_note:'verified'}]);
  const repo=new FinanceOperationsPostgresRepository(db);
  const row=await repo.resolvePaymentException({exceptionId:EXCEPTION_ID,actorSubject:'fin-mgr',at:'2026-09-06T07:00:00.000Z',resolutionNote:'verified'});
  assert.equal(row.status,'RESOLVED');
  assert.match(db.calls[0].text,/status='OPEN'/i);
  assert.match(db.calls[0].text,/created_by_subject <> \$2/i);
  assert.deepEqual(db.calls[0].params,[EXCEPTION_ID,'fin-mgr','2026-09-06T07:00:00.000Z','verified']);
});
