'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHttpApp}=require('../../services/api/src/http-app');
const {resolveActorFromClaims}=require('../../packages/auth');

async function withService(service,fn){
  const handler=createHttpApp(service,req=>resolveActorFromClaims({sub:'mag-a',roles:['MAG'],court_ids:['11111111-1111-1111-1111-111111111111']}));
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{return await fn(base);}finally{await new Promise(r=>server.close(r));}
}

test('HTTP starts a hearing',async()=>{
  const service={async startHearing(_actor,id){return {hearingId:id,status:'IN_PROGRESS',startedBy:'mag-a'};}};
  await withService(service,async base=>{
    const res=await fetch(base+'/hearings/h-1/start',{method:'POST'});
    assert.equal(res.status,200);
    const body=await res.json();
    assert.equal(body.status,'IN_PROGRESS');
  });
});

test('HTTP records a hearing appearance',async()=>{
  const service={async recordAppearance(_actor,id,input){return {appearanceId:'ap-1',hearingId:id,...input,recordedBy:'mag-a'};}};
  await withService(service,async base=>{
    const res=await fetch(base+'/hearings/h-1/appearances',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({participantName:'Jane Doe',participantRole:'DEFENDANT',appearanceMode:'IN_PERSON'})});
    assert.equal(res.status,201);
    const body=await res.json();
    assert.equal(body.participantName,'Jane Doe');
  });
});

test('HTTP records a proceeding note or external record reference',async()=>{
  const service={async recordProceeding(_actor,id,input){return {proceedingId:'pr-1',hearingId:id,...input,recordedBy:'mag-a'};}};
  await withService(service,async base=>{
    const res=await fetch(base+'/hearings/h-1/proceedings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({recordReference:'AUDIO-2026-0001'})});
    assert.equal(res.status,201);
    const body=await res.json();
    assert.equal(body.recordReference,'AUDIO-2026-0001');
  });
});

test('HTTP completes a hearing with server-controlled COMPLETED status',async()=>{
  const service={async completeHearing(_actor,id,input){return {hearingId:id,status:'COMPLETED',outcomeCode:input.outcomeCode,completedBy:'mag-a'};}};
  await withService(service,async base=>{
    const res=await fetch(base+'/hearings/h-1/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcomeCode:'DECISION_RESERVED'})});
    assert.equal(res.status,200);
    const body=await res.json();
    assert.equal(body.status,'COMPLETED');
    assert.equal(body.outcomeCode,'DECISION_RESERVED');
  });
});
