'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHttpApp}=require('../../services/api/src/http-app');
const {resolveActorFromClaims}=require('../../packages/auth');

async function withService(service,fn){
  const handler=createHttpApp(service,req=>resolveActorFromClaims({sub:'actor',roles:['FIN'],court_ids:['COURT-A']}));
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{return await fn(base);}finally{await new Promise(r=>server.close(r));}
}

test('HTTP exposes court-scoped notification history with controlled filters',async()=>{
  const calls=[];
  const service={
    async listNotifications(_actor,filters){calls.push(filters);return [{notificationId:'n-1',courtId:'COURT-A',channel:'EMAIL',status:'QUEUED'}];}
  };
  await withService(service,async base=>{
    const res=await fetch(base+'/notifications?status=queued&channel=email');
    assert.equal(res.status,200);
    const body=await res.json();
    assert.equal(body[0].notificationId,'n-1');
  });
  assert.deepEqual(calls,[{status:'queued',channel:'email'}]);
});

test('HTTP does not expose ordinary-user delivery-state mutation endpoint',async()=>{
  const service={async listNotifications(){return [];}};
  await withService(service,async base=>{
    const res=await fetch(base+'/notifications/n-1/delivery-attempts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcome:'DELIVERED'})});
    assert.equal(res.status,404);
  });
});
