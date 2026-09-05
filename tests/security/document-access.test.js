'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {resolveActorFromClaims}=require('../../packages/auth');
const {DciecmsService}=require('../../services/api/src/dciecms-service');
const regA=resolveActorFromClaims({sub:'reg-a',roles:['REG'],court_ids:['COURT-A']});
const regB=resolveActorFromClaims({sub:'reg-b',roles:['REG'],court_ids:['COURT-B']});
function fixture(){ const svc=new DciecmsService(); const p=svc.createParty(regA,{courtId:'COURT-A',partyType:'PERSON',displayName:'Jane'}); const f=svc.createFilingDraft(regA,{courtId:'COURT-A',caseTypeCode:'CIVIL',filerPartyId:p.partyId}); return {svc,f}; }
test('document enters quarantine with required checksum and no public storage url',()=>{ const {svc,f}=fixture(); const d=svc.registerDocument(regA,f.filingId,{fileName:'claim.pdf',mimeType:'application/pdf',sizeBytes:12,checksumSha256:'a'.repeat(64)}); assert.equal(d.status,'QUARANTINED'); assert.equal('storageUrl' in d,false); });
test('invalid checksum is rejected',()=>{ const {svc,f}=fixture(); assert.throws(()=>svc.registerDocument(regA,f.filingId,{fileName:'x.pdf',mimeType:'application/pdf',checksumSha256:'bad'}),/SHA-256/i); });
test('wrong-court direct document identifier is denied',()=>{ const {svc,f}=fixture(); const d=svc.registerDocument(regA,f.filingId,{fileName:'x.pdf',mimeType:'application/pdf',checksumSha256:'b'.repeat(64)}); assert.throws(()=>svc.getDocument(regB,d.documentId),/court scope/i); });
