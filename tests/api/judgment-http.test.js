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

test('HTTP creates a draft judgment for a case',async()=>{
  const service={async createJudgment(_a,id,input){return {judgmentId:'j-1',caseId:id,status:'DRAFT',title:input.title};}};
  await withService(service,async base=>{const r=await fetch(base+'/cases/c-1/judgments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hearingId:'h-1',decisionType:'JUDGMENT',title:'Decision',content:'Reasons.'})});assert.equal(r.status,201);assert.equal((await r.json()).status,'DRAFT');});
});

test('HTTP edits only a draft judgment through service authority',async()=>{
  const service={async updateJudgmentDraft(_a,id,input){return {judgmentId:id,status:'DRAFT',version:2,title:input.title};}};
  await withService(service,async base=>{const r=await fetch(base+'/judgments/j-1',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Revised',content:'Revised reasons.'})});assert.equal(r.status,200);assert.equal((await r.json()).version,2);});
});

test('HTTP exposes review, sign and issue transitions',async()=>{
  const service={
    async reviewJudgment(_a,id){return {judgmentId:id,status:'FINAL'};},
    async signJudgment(_a,id){return {judgmentId:id,status:'SIGNED'};},
    async issueJudgment(_a,id){return {judgmentId:id,status:'ISSUED'};}
  };
  await withService(service,async base=>{
    let r=await fetch(base+'/judgments/j-1/review',{method:'POST'});assert.equal(r.status,200);assert.equal((await r.json()).status,'FINAL');
    r=await fetch(base+'/judgments/j-1/sign',{method:'POST'});assert.equal(r.status,200);assert.equal((await r.json()).status,'SIGNED');
    r=await fetch(base+'/judgments/j-1/issue',{method:'POST'});assert.equal(r.status,200);assert.equal((await r.json()).status,'ISSUED');
  });
});
