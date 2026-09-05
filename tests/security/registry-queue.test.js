'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {resolveActorFromClaims}=require('../../packages/auth'); const {DciecmsService}=require('../../services/api/src/dciecms-service');
const regA=resolveActorFromClaims({sub:'a',roles:['REG'],court_ids:['COURT-A']}); const regB=resolveActorFromClaims({sub:'b',roles:['REG'],court_ids:['COURT-B']}); const ict=resolveActorFromClaims({sub:'i',roles:['ICT-ADMIN'],court_ids:['COURT-A']});
function seed(svc,actor,court,name){const p=svc.createParty(actor,{courtId:court,partyType:'PERSON',displayName:name}); const f=svc.createFilingDraft(actor,{courtId:court,caseTypeCode:'CIVIL',filerPartyId:p.partyId}); svc.submitFiling(actor,f.filingId,'k-'+name); return f;}
test('registry queue includes only submitted filings in actor court scope',()=>{const svc=new DciecmsService(); seed(svc,regA,'COURT-A','A'); seed(svc,regB,'COURT-B','B'); const rows=svc.listRegistryQueue(regA); assert.equal(rows.length,1); assert.equal(rows[0].courtId,'COURT-A');});
test('ICT administrator cannot use registry queue solely by admin role',()=>{const svc=new DciecmsService(); assert.throws(()=>svc.listRegistryQueue(ict),/permission|registry role/i);});
