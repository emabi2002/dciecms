'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHttpApp}=require('../../services/api/src/http-app');
const {resolveActorFromClaims}=require('../../packages/auth');

async function withService(service,fn){
  const handler=createHttpApp(service,req=>resolveActorFromClaims({sub:'mag-a',roles:String(req.headers['x-dev-roles']||'MAG').split(','),court_ids:['11111111-1111-1111-1111-111111111111']}));
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{return await fn(base);}finally{await new Promise(r=>server.close(r));}
}

test('HTTP creates a hearing for a case',async()=>{
  const calls=[];
  const service={async scheduleHearing(_actor,caseId,input){calls.push([caseId,input.hearingType]);return {hearingId:'h-1',caseId,status:'SCHEDULED',hearingType:input.hearingType};}};
  await withService(service,async base=>{
    const res=await fetch(base+'/cases/c-1/hearings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hearingType:'MENTION',scheduledStart:'2026-09-07T09:00:00.000Z',scheduledEnd:'2026-09-07T09:30:00.000Z'})});
    assert.equal(res.status,201);
    const body=await res.json();
    assert.equal(body.status,'SCHEDULED');
    assert.equal(body.caseId,'c-1');
  });
  assert.deepEqual(calls,[['c-1','MENTION']]);
});

test('HTTP returns the court-scoped daily hearing list',async()=>{
  const service={async listDailyHearings(_actor,input){return [{hearingId:'h-1',status:'SCHEDULED',scheduledStart:`${input.date}T09:00:00.000Z`}];}};
  await withService(service,async base=>{
    const res=await fetch(base+'/judicial/daily-list?date=2026-09-07');
    assert.equal(res.status,200);
    const body=await res.json();
    assert.equal(body.length,1);
    assert.equal(body[0].hearingId,'h-1');
  });
});

test('HTTP adjourns a hearing with reason and optional next date',async()=>{
  const calls=[];
  const service={async adjournHearing(_actor,hearingId,input){calls.push([hearingId,input.reason,input.nextStart]);return {hearingId,status:'ADJOURNED',adjournmentReason:input.reason,nextHearing:input.nextStart?{hearingId:'h-2',status:'SCHEDULED',scheduledStart:input.nextStart}:null};}};
  await withService(service,async base=>{
    const res=await fetch(base+'/hearings/h-1/adjourn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:'Witness unavailable',nextStart:'2026-09-14T09:00:00.000Z',nextEnd:'2026-09-14T09:30:00.000Z'})});
    assert.equal(res.status,200);
    const body=await res.json();
    assert.equal(body.status,'ADJOURNED');
    assert.equal(body.nextHearing.status,'SCHEDULED');
  });
  assert.equal(calls[0][0],'h-1');
  assert.equal(calls[0][1],'Witness unavailable');
});
