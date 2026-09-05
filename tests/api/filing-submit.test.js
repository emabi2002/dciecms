'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {resolveActorFromClaims}=require('../../packages/auth'); const {DciecmsService}=require('../../services/api/src/dciecms-service');
const reg=resolveActorFromClaims({sub:'reg',roles:['REG'],court_ids:['COURT-A']});
function fixture(){ const svc=new DciecmsService(); const p=svc.createParty(reg,{courtId:'COURT-A',partyType:'PERSON',displayName:'Jane'}); const f=svc.createFilingDraft(reg,{courtId:'COURT-A',caseTypeCode:'CIVIL',filerPartyId:p.partyId}); return {svc,f}; }
test('filing submit moves draft to submitted',()=>{ const {svc,f}=fixture(); const x=svc.submitFiling(reg,f.filingId,'idem-1'); assert.equal(x.status,'SUBMITTED'); assert.ok(x.submittedAt); });
test('same idempotency key returns same transition without duplicate audit',()=>{ const {svc,f}=fixture(); const a=svc.submitFiling(reg,f.filingId,'idem-1'); const b=svc.submitFiling(reg,f.filingId,'idem-1'); assert.equal(a.submittedAt,b.submittedAt); assert.equal(svc.audit.list({action:'filing.submit'}).length,1); });
