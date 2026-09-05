'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveActorFromClaims } = require('../../packages/auth');
const { PersistentDciecmsService } = require('../../services/api/src/persistent-dciecms-service');

const fin = resolveActorFromClaims({ sub:'fin-maker', roles:['FIN'], court_ids:['COURT-A'] });
const finMgr = resolveActorFromClaims({ sub:'fin-checker', roles:['FIN-MGR'], court_ids:['COURT-A'] });

class ControlRepo {
  constructor(){
    this.payment={paymentId:'pay-1',assessmentId:'assess-1',courtId:'COURT-A',amountMinor:12500,currency:'PGK',status:'CONFIRMED',providerReference:'PGW-1'};
    this.receipt=null;
    this.reconciliation=null;
  }
  async getPayment(id){ return id==='pay-1' ? this.payment : null; }
  async getReceiptByPayment(id){ return this.receipt?.paymentId===id ? this.receipt : null; }
  async createReceipt(input){
    this.receipt={receiptId:input.receiptId,receiptNumber:input.receiptNumber,paymentId:input.paymentId,courtId:input.courtId,amountMinor:input.amountMinor,currency:input.currency,status:'ISSUED',issuedBy:input.actorSubject,issuedAt:input.at};
    return this.receipt;
  }
  async createReconciliation(input){
    this.reconciliation={reconciliationId:input.reconciliationId,paymentId:input.paymentId,courtId:input.courtId,status:'PREPARED',preparedBy:input.actorSubject,preparedAt:input.at,certifiedBy:null,certifiedAt:null};
    return this.reconciliation;
  }
  async getReconciliation(id){ return this.reconciliation?.reconciliationId===id ? this.reconciliation : null; }
  async certifyReconciliation(input){
    this.reconciliation={...this.reconciliation,status:'CERTIFIED',certifiedBy:input.actorSubject,certifiedAt:input.at};
    return this.reconciliation;
  }
}

test('confirmed payment can issue exactly one court-scoped receipt', async()=>{
  const repo=new ControlRepo();
  const svc=new PersistentDciecmsService({repository:repo});
  const receipt=await svc.issueReceipt(fin,'pay-1');
  assert.equal(receipt.status,'ISSUED');
  assert.equal(receipt.amountMinor,12500);
  assert.equal(receipt.currency,'PGK');
  assert.match(receipt.receiptNumber,/^RCT-/);
  const same=await svc.issueReceipt(fin,'pay-1');
  assert.equal(same.receiptId,receipt.receiptId);
});

test('reconciliation uses maker-checker segregation of duties', async()=>{
  const repo=new ControlRepo();
  const svc=new PersistentDciecmsService({repository:repo});
  const reconciliation=await svc.createReconciliation(fin,'pay-1');
  assert.equal(reconciliation.status,'PREPARED');
  await assert.rejects(()=>svc.certifyReconciliation(fin,reconciliation.reconciliationId),/Permission denied|FIN-MGR|manager/i);
  const certified=await svc.certifyReconciliation(finMgr,reconciliation.reconciliationId);
  assert.equal(certified.status,'CERTIFIED');
  assert.equal(certified.certifiedBy,'fin-checker');
});

test('same actor cannot prepare and certify a reconciliation even with both roles', async()=>{
  const both=resolveActorFromClaims({sub:'dual-role',roles:['FIN','FIN-MGR'],court_ids:['COURT-A']});
  const repo=new ControlRepo(); const svc=new PersistentDciecmsService({repository:repo});
  const reconciliation=await svc.createReconciliation(both,'pay-1');
  await assert.rejects(()=>svc.certifyReconciliation(both,reconciliation.reconciliationId),/segregation|same actor|maker/i);
});

test('finance control migration creates receipts and reconciliations and fee assessment timestamp matches repository contract',()=>{
  const finance=fs.readFileSync(path.join(process.cwd(),'db/migrations/0004_finance.sql'),'utf8');
  assert.match(finance,/assessed_at timestamptz NOT NULL DEFAULT now\(\)/i);
  const controls=fs.readFileSync(path.join(process.cwd(),'db/migrations/0005_finance_controls.sql'),'utf8');
  assert.match(controls,/CREATE TABLE IF NOT EXISTS finance\.receipts/i);
  assert.match(controls,/payment_id uuid NOT NULL UNIQUE/i);
  assert.match(controls,/receipt_number varchar\(80\) NOT NULL UNIQUE/i);
  assert.match(controls,/CREATE TABLE IF NOT EXISTS finance\.reconciliations/i);
  assert.match(controls,/prepared_by_subject varchar\(255\) NOT NULL/i);
  assert.match(controls,/certified_by_subject varchar\(255\)/i);
});
