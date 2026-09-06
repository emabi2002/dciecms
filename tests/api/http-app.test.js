'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHttpApp}=require('../../services/api/src/http-app');
const {DciecmsService}=require('../../services/api/src/dciecms-service');
const {resolveActorFromClaims,AuthenticationError,AuthenticationUnavailableError}=require('../../packages/auth');

async function withServer(fn){
  const svc=new DciecmsService();
  return withCustomService(svc, fn);
}

async function withCustomService(svc, fn){
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

async function withResolver(resolver, service, fn){
  const server=http.createServer(createHttpApp(service,resolver));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{return await fn(base);} finally {await new Promise(resolve=>server.close(resolve));}
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

test('HTTP adapter awaits asynchronous persistent-service results',async()=>{
  const svc={
    async createParty(){ return {partyId:'p-async',courtId:'COURT-A',partyType:'PERSON',displayName:'Async Party'}; }
  };
  await withCustomService(svc, async(base)=>{
    const res=await fetch(base+'/parties',{method:'POST',headers:hdr,body:JSON.stringify({courtId:'COURT-A',partyType:'PERSON',displayName:'Async Party'})});
    assert.equal(res.status,201);
    const body=await res.json();
    assert.equal(body.partyId,'p-async');
    assert.equal(body.displayName,'Async Party');
  });
});

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

test('registry decision endpoints pass reasons and accepted state through HTTP adapter',async()=>{
  const calls=[];
  const svc={
    async returnFiling(_actor,id,reason){calls.push(['return',id,reason]); return {filingId:id,status:'RETURNED',decisionReason:reason};},
    async rejectFiling(_actor,id,reason){calls.push(['reject',id,reason]); return {filingId:id,status:'REJECTED',decisionReason:reason};},
    async acceptFiling(_actor,id){calls.push(['accept',id]); return {filingId:id,status:'ACCEPTED'};}
  };
  const mgr={...hdr,'x-dev-roles':'REG-MGR'};
  await withCustomService(svc,async(base)=>{
    let res=await fetch(base+'/filings/f-1/return',{method:'POST',headers:hdr,body:JSON.stringify({reason:'Missing attachment'})});
    assert.equal(res.status,200); assert.equal((await res.json()).status,'RETURNED');
    res=await fetch(base+'/filings/f-1/reject',{method:'POST',headers:mgr,body:JSON.stringify({reason:'Not within jurisdiction'})});
    assert.equal(res.status,200); assert.equal((await res.json()).status,'REJECTED');
    res=await fetch(base+'/filings/f-1/accept',{method:'POST',headers:mgr,body:'{}'});
    assert.equal(res.status,200); assert.equal((await res.json()).status,'ACCEPTED');
  });
  assert.deepEqual(calls,[['return','f-1','Missing attachment'],['reject','f-1','Not within jurisdiction'],['accept','f-1']]);
});

test('finance endpoints expose assessment, pending payment and controlled confirmation',async()=>{
  const svc={
    async assessFilingFee(_actor,id,input){return {assessmentId:'a-1',filingId:id,courtId:'COURT-A',amountMinor:input.amountMinor,currency:input.currency,status:'ASSESSED'};},
    async createPayment(_actor,id){return {paymentId:'pay-1',assessmentId:id,courtId:'COURT-A',amountMinor:12500,currency:'PGK',status:'PENDING'};},
    async confirmPayment(_actor,id,providerReference){return {paymentId:id,status:'CONFIRMED',providerReference};}
  };
  const fin={'content-type':'application/json','x-dev-sub':'fin-a','x-dev-roles':'FIN','x-dev-courts':'COURT-A'};
  const finMgr={...fin,'x-dev-sub':'fin-mgr-a','x-dev-roles':'FIN-MGR'};
  await withCustomService(svc,async(base)=>{
    let res=await fetch(base+'/filings/f-1/fee-assessments',{method:'POST',headers:fin,body:JSON.stringify({amountMinor:12500,currency:'PGK'})});
    assert.equal(res.status,201); const assessment=await res.json(); assert.equal(assessment.status,'ASSESSED');
    res=await fetch(base+`/fee-assessments/${assessment.assessmentId}/payments`,{method:'POST',headers:fin,body:'{}'});
    assert.equal(res.status,201); const payment=await res.json(); assert.equal(payment.status,'PENDING');
    res=await fetch(base+`/payments/${payment.paymentId}/confirm`,{method:'POST',headers:finMgr,body:JSON.stringify({providerReference:'PGW-1'})});
    assert.equal(res.status,200); const confirmed=await res.json(); assert.equal(confirmed.status,'CONFIRMED'); assert.equal(confirmed.providerReference,'PGW-1');
  });
});

test('ICT admin receives 403 on registry queue without metadata leakage',async()=>withServer(async(base)=>{
  const res=await fetch(base+'/registry/filings',{headers:{'x-dev-sub':'ict','x-dev-roles':'ICT-ADMIN','x-dev-courts':'COURT-A'}});
  assert.equal(res.status,403); assert.equal(res.headers.get('www-authenticate'),null); const body=await res.json(); assert.equal(body.error,'forbidden'); assert.equal(Object.keys(body).includes('resourceId'),false);
}));

test('unknown route returns 404',async()=>withServer(async(base)=>{ const res=await fetch(base+'/missing',{headers:hdr}); assert.equal(res.status,404); }));

test('HTTP adapter awaits asynchronous actor resolver',async()=>{
  await withResolver(
    async()=>({userId:'u-1',roles:['REG'],courtIds:['COURT-A'],explicitGrants:[]}),
    {async listRegistryQueue(actor){assert.equal(actor.userId,'u-1'); return[];}},
    async base=>assert.equal((await fetch(`${base}/registry/filings`)).status,200)
  );
});

test('authentication failure returns sanitized 401 bearer challenge',async()=>{
  await withResolver(
    async()=>{throw new AuthenticationError('wrong audience secret detail');},
    {},
    async base=>{
      const response=await fetch(`${base}/registry/filings`);
      assert.equal(response.status,401);
      assert.equal(response.headers.get('www-authenticate'),'Bearer');
      assert.deepEqual(await response.json(),{error:'unauthorized'});
    }
  );
});

test('authentication error response never echoes bearer material or verifier detail',async()=>{
  const sentinel='TOKEN_SENTINEL_DO_NOT_LEAK';
  await withResolver(
    async req=>{
      throw new AuthenticationError(`invalid ${req.headers.authorization} verifier-internal-detail`);
    },
    {},
    async base=>{
      const response=await fetch(`${base}/registry/filings`,{
        headers:{authorization:`Bearer ${sentinel}`}
      });
      const text=await response.text();
      assert.equal(response.status,401);
      assert.equal(response.headers.get('www-authenticate'),'Bearer');
      assert.equal(text.includes(sentinel),false);
      assert.equal(text.includes('verifier-internal-detail'),false);
    }
  );
});

test('authentication infrastructure failure returns sanitized 503',async()=>{
  await withResolver(
    async()=>{throw new AuthenticationUnavailableError('jwks network detail');},
    {},
    async base=>{
      const response=await fetch(`${base}/registry/filings`);
      assert.equal(response.status,503);
      assert.equal(response.headers.get('www-authenticate'),null);
      assert.deepEqual(await response.json(),{error:'authentication_unavailable'});
    }
  );
});

test('unexpected authentication boundary error returns sanitized 500',async()=>{
  await withResolver(
    async()=>{throw new Error('INTERNAL_AUTH_DETAIL_DO_NOT_LEAK');},
    {},
    async base=>{
      const response=await fetch(`${base}/registry/filings`);
      const text=await response.text();
      assert.equal(response.status,500);
      assert.equal(response.headers.get('www-authenticate'),null);
      assert.equal(text.includes('INTERNAL_AUTH_DETAIL_DO_NOT_LEAK'),false);
      assert.deepEqual(JSON.parse(text),{error:'internal_error'});
    }
  );
});
