'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHttpApp}=require('../../services/api/src/http-app');
const {DciecmsService}=require('../../services/api/src/dciecms-service');
const {resolveActorFromClaims}=require('../../packages/auth');

async function withServer(fn){
  const svc=new DciecmsService();
  const handler=createHttpApp(svc, req=>{
    const sub=req.headers['x-dev-sub'];
    if(!sub) return null;
    const roles=String(req.headers['x-dev-roles']||'').split(',').filter(Boolean);
    const courts=String(req.headers['x-dev-courts']||'').split(',').filter(Boolean);
    return resolveActorFromClaims({sub,roles,court_ids:courts});
  });
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{return await fn(base,svc);} finally {await new Promise(r=>server.close(r));}
}
const hdr={'content-type':'application/json','x-dev-sub':'reg-a','x-dev-roles':'REG','x-dev-courts':'COURT-A'};

test('protected route returns 401 without actor',async()=>withServer(async(base)=>{
  const res=await fetch(base+'/registry/filings'); assert.equal(res.status,401); const body=await res.json(); assert.equal(body.error,'unauthorized');
}));

test('party and filing can be created through HTTP adapter',async()=>withServer(async(base)=>{
  let res=await fetch(base+'/parties',{method:'POST',headers:hdr,body:JSON.stringify({courtId:'COURT-A',partyType:'PERSON',displayName:'Jane Doe'})});
  assert.equal(res.status,201); const party=await res.json();
  res=await fetch(base+'/filings',{method:'POST',headers:hdr,body:JSON.stringify({courtId:'COURT-A',caseTypeCode:'CIVIL',filerPartyId:party.partyId})});
  assert.equal(res.status,201); const filing=await res.json(); assert.equal(filing.status,'DRAFT');
}));

test('registry workflow tasks and filing validation are exposed through HTTP adapter',async()=>withServer(async(base)=>{
  let res=await fetch(base+'/parties',{method:'POST',headers:hdr,body:JSON.stringify({courtId:'COURT-A',partyType:'PERSON',displayName:'Jane Doe'})});
  const party=await res.json();
  res=await fetch(base+'/filings',{method:'POST',headers:hdr,body:JSON.stringify({courtId:'COURT-A',caseTypeCode:'CIVIL',filerPartyId:party.partyId})});
  const filing=await res.json();
  res=await fetch(base+`/filings/${filing.filingId}/submit`,{method:'POST',headers:{...hdr,'idempotency-key':'http-submit-1'},body:'{}'});
  assert.equal(res.status,200);

  res=await fetch(base+'/workflow/tasks',{headers:hdr});
  assert.equal(res.status,200); let tasks=await res.json(); assert.equal(tasks.length,1); assert.equal(tasks[0].filingId,filing.filingId);

  res=await fetch(base+`/filings/${filing.filingId}/validate`,{method:'POST',headers:hdr,body:'{}'});
  assert.equal(res.status,200); const validated=await res.json(); assert.equal(validated.status,'VALIDATED');

  res=await fetch(base+'/workflow/tasks',{headers:hdr});
  tasks=await res.json(); assert.equal(tasks.length,0);
  res=await fetch(base+'/workflow/tasks?includeCompleted=true',{headers:hdr});
  tasks=await res.json(); assert.equal(tasks.length,1); assert.equal(tasks[0].status,'COMPLETED');
}));

test('ICT admin receives 403 on registry queue without metadata leakage',async()=>withServer(async(base)=>{
  const res=await fetch(base+'/registry/filings',{headers:{'x-dev-sub':'ict','x-dev-roles':'ICT-ADMIN','x-dev-courts':'COURT-A'}});
  assert.equal(res.status,403); const body=await res.json(); assert.equal(body.error,'forbidden'); assert.equal(Object.keys(body).includes('resourceId'),false);
}));

test('unknown route returns 404',async()=>withServer(async(base)=>{ const res=await fetch(base+'/missing',{headers:hdr}); assert.equal(res.status,404); }));
