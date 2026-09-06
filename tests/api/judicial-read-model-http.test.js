'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHttpApp}=require('../../services/api/src/http-app');
const {resolveActorFromClaims}=require('../../packages/auth');

async function withService(service,fn){
  const handler=createHttpApp(service,()=>resolveActorFromClaims({sub:'mag-a',roles:['MAG'],court_ids:['11111111-1111-1111-1111-111111111111']}));
  const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;try{return await fn(base);}finally{await new Promise(r=>server.close(r));}
}

test('HTTP exposes judicial case, hearing and judgment detail read models',async()=>{
  const service={
    async getJudicialCase(_a,id){return {caseId:id,caseNumber:'POM-CIVIL-2026-000001'};},
    async getJudicialHearing(_a,id){return {hearingId:id,status:'COMPLETED'};},
    async getJudgment(_a,id){return {judgmentId:id,status:'DRAFT'};}
  };
  await withService(service,async base=>{
    let r=await fetch(base+'/judicial/cases/c-1');assert.equal(r.status,200);assert.equal((await r.json()).caseId,'c-1');
    r=await fetch(base+'/judicial/hearings/h-1');assert.equal(r.status,200);assert.equal((await r.json()).hearingId,'h-1');
    r=await fetch(base+'/judicial/judgments/j-1');assert.equal(r.status,200);assert.equal((await r.json()).judgmentId,'j-1');
  });
});

test('HTTP exposes the authenticated pending decisions queue',async()=>{
  const service={async listPendingDecisions(){return [{judgmentId:'j-1',status:'DRAFT'}];}};
  await withService(service,async base=>{const r=await fetch(base+'/judicial/pending-decisions');assert.equal(r.status,200);const rows=await r.json();assert.equal(rows.length,1);assert.equal(rows[0].status,'DRAFT');});
});
