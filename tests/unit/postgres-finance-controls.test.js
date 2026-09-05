'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PostgresRepository}=require('../../services/api/src/postgres-repository');

class FakeQueryable{
  constructor(responses=[]){this.responses=[...responses];this.calls=[];}
  async query(text,params=[]){this.calls.push({text,params});return this.responses.shift()||{rows:[]};}
}

test('PostgresRepository issues and retrieves one receipt per payment with parameterized SQL',async()=>{
  const receiptRow={receipt_id:'r-1',receipt_number:'RCT-1',payment_id:'p-1',court_id:'c-1',amount_minor:'12500',currency:'PGK',status:'ISSUED',issued_by_subject:'fin-a',issued_at:'2026-09-06T00:00:00Z'};
  const db=new FakeQueryable([{rows:[receiptRow]},{rows:[receiptRow]}]);
  const repo=new PostgresRepository(db);
  const issued=await repo.createReceipt({receiptId:'r-1',receiptNumber:'RCT-1',paymentId:'p-1',courtId:'c-1',amountMinor:12500,currency:'PGK',actorSubject:'fin-a',at:'2026-09-06T00:00:00Z'});
  assert.equal(issued.receiptNumber,'RCT-1');
  assert.match(db.calls[0].text,/INSERT INTO finance\.receipts/i);
  assert.equal(db.calls[0].text.includes('RCT-1'),false);
  const fetched=await repo.getReceiptByPayment('p-1');
  assert.equal(fetched.receiptId,'r-1');
  assert.deepEqual(db.calls[1].params,['p-1']);
});

test('PostgresRepository prepares and certifies reconciliation with maker-checker persistence',async()=>{
  const prepared={reconciliation_id:'rec-1',payment_id:'p-1',court_id:'c-1',status:'PREPARED',prepared_by_subject:'fin-maker',prepared_at:'2026-09-06T00:00:00Z',certified_by_subject:null,certified_at:null};
  const certified={...prepared,status:'CERTIFIED',certified_by_subject:'fin-checker',certified_at:'2026-09-06T00:10:00Z'};
  const db=new FakeQueryable([{rows:[prepared]},{rows:[prepared]},{rows:[certified]}]);
  const repo=new PostgresRepository(db);
  const created=await repo.createReconciliation({reconciliationId:'rec-1',paymentId:'p-1',courtId:'c-1',actorSubject:'fin-maker',at:'2026-09-06T00:00:00Z'});
  assert.equal(created.preparedBy,'fin-maker');
  const fetched=await repo.getReconciliation('rec-1');
  assert.equal(fetched.status,'PREPARED');
  const result=await repo.certifyReconciliation({reconciliationId:'rec-1',actorSubject:'fin-checker',at:'2026-09-06T00:10:00Z'});
  assert.equal(result.status,'CERTIFIED');
  assert.equal(result.certifiedBy,'fin-checker');
  assert.match(db.calls[2].text,/prepared_by_subject <> \$2/i);
});
