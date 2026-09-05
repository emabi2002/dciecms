'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHttpApp}=require('../../services/api/src/http-app');
const {resolveActorFromClaims}=require('../../packages/auth');

async function withService(service,fn){
  const handler=createHttpApp(service,req=>resolveActorFromClaims({sub:'actor',roles:String(req.headers['x-dev-roles']||'FIN-MGR').split(','),court_ids:['COURT-A']}));
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{return await fn(base);}finally{await new Promise(r=>server.close(r));}
}

test('HTTP exposes receipt issuance and reconciliation maker-checker actions',async()=>{
  const calls=[];
  const service={
    async issueReceipt(_a,id){calls.push(['receipt',id]);return {receiptId:'r-1',paymentId:id,status:'ISSUED'};},
    async createReconciliation(_a,id){calls.push(['prepare',id]);return {reconciliationId:'rec-1',paymentId:id,status:'PREPARED'};},
    async certifyReconciliation(_a,id){calls.push(['certify',id]);return {reconciliationId:id,status:'CERTIFIED'};}
  };
  await withService(service,async base=>{
    let res=await fetch(base+'/payments/p-1/receipt',{method:'POST',headers:{'x-dev-roles':'FIN'}});
    assert.equal(res.status,201); assert.equal((await res.json()).status,'ISSUED');
    res=await fetch(base+'/payments/p-1/reconciliations',{method:'POST',headers:{'x-dev-roles':'FIN'}});
    assert.equal(res.status,201); assert.equal((await res.json()).status,'PREPARED');
    res=await fetch(base+'/reconciliations/rec-1/certify',{method:'POST',headers:{'x-dev-roles':'FIN-MGR'}});
    assert.equal(res.status,200); assert.equal((await res.json()).status,'CERTIFIED');
  });
  assert.deepEqual(calls,[['receipt','p-1'],['prepare','p-1'],['certify','rec-1']]);
});

test('HTTP exposes controlled case opening after payment confirmation',async()=>{
  const service={async openCase(_a,filingId,paymentId){return {caseId:'c-1',filingId,paymentId,caseNumber:'POM-CIVIL-2026-000001',status:'AWAITING_ASSIGNMENT'};}};
  await withService(service,async base=>{
    const res=await fetch(base+'/filings/f-1/open-case',{method:'POST',headers:{'content-type':'application/json','x-dev-roles':'REG-MGR'},body:JSON.stringify({paymentId:'p-1'})});
    assert.equal(res.status,201);
    const body=await res.json();
    assert.equal(body.caseNumber,'POM-CIVIL-2026-000001');
    assert.equal(body.status,'AWAITING_ASSIGNMENT');
  });
});
