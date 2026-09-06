'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHttpApp}=require('../../services/api/src/http-app');
const {resolveActorFromClaims}=require('../../packages/auth');

async function withService(service,fn){
  const handler=createHttpApp(service,req=>resolveActorFromClaims({sub:'actor',roles:String(req.headers['x-dev-roles']||'MAG').split(','),court_ids:['11111111-1111-1111-1111-111111111111']}));
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{return await fn(base);}finally{await new Promise(r=>server.close(r));}
}

test('HTTP exposes CMAG case assignment',async()=>{
  const calls=[];
  const service={
    async assignCase(_actor,caseId,input){
      calls.push([caseId,input.assigneeSubject]);
      return {caseId,caseNumber:'POM-CIVIL-2026-000001',status:'ASSIGNED',assignedToSubject:input.assigneeSubject};
    }
  };
  await withService(service,async base=>{
    const res=await fetch(base+'/cases/c-1/assign',{
      method:'POST',
      headers:{'content-type':'application/json','x-dev-roles':'CMAG'},
      body:JSON.stringify({assigneeSubject:'mag-a'})
    });
    assert.equal(res.status,200);
    const body=await res.json();
    assert.equal(body.status,'ASSIGNED');
    assert.equal(body.assignedToSubject,'mag-a');
  });
  assert.deepEqual(calls,[['c-1','mag-a']]);
});

test('HTTP exposes the authenticated magistrate judicial queue',async()=>{
  const service={
    async listMyCases(actor){
      return [{caseId:'c-1',caseNumber:'POM-CIVIL-2026-000001',status:'ASSIGNED',assignedToSubject:actor.userId}];
    }
  };
  await withService(service,async base=>{
    const res=await fetch(base+'/judicial/my-cases',{headers:{'x-dev-roles':'MAG'}});
    assert.equal(res.status,200);
    const body=await res.json();
    assert.equal(body.length,1);
    assert.equal(body[0].assignedToSubject,'actor');
  });
});
