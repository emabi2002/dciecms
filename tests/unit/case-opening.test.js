'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {resolveActorFromClaims}=require('../../packages/auth');
const {PersistentDciecmsService}=require('../../services/api/src/persistent-dciecms-service');

const regMgr=resolveActorFromClaims({sub:'reg-mgr',roles:['REG-MGR'],court_ids:['COURT-A']});

class CaseRepo{
  constructor(){
    this.filing={filingId:'f-1',courtId:'COURT-A',caseTypeCode:'CIVIL',status:'ACCEPTED'};
    this.assessment={assessmentId:'a-1',filingId:'f-1',courtId:'COURT-A',status:'ASSESSED'};
    this.payment={paymentId:'p-1',assessmentId:'a-1',courtId:'COURT-A',status:'CONFIRMED'};
    this.case=null;
  }
  async getFiling(id){return id==='f-1'?this.filing:null;}
  async getPayment(id){return id==='p-1'?this.payment:null;}
  async getFeeAssessment(id){return id==='a-1'?this.assessment:null;}
  async getCaseByFiling(id){return this.case?.filingId===id?this.case:null;}
  async openCaseFromConfirmedPayment(input){
    this.case={caseId:input.caseId,caseNumber:'POM-CIVIL-2026-000001',filingId:input.filingId,paymentId:input.paymentId,courtId:input.courtId,caseTypeCode:input.caseTypeCode,status:'AWAITING_ASSIGNMENT',openedBy:input.actorSubject,openedAt:input.openedAt};
    return this.case;
  }
}

test('registry manager opens one case only after confirmed payment for the same filing',async()=>{
  const repo=new CaseRepo(); const svc=new PersistentDciecmsService({repository:repo});
  const opened=await svc.openCase(regMgr,'f-1','p-1');
  assert.equal(opened.status,'AWAITING_ASSIGNMENT');
  assert.equal(opened.filingId,'f-1');
  assert.match(opened.caseNumber,/CIVIL-2026-/);
  const same=await svc.openCase(regMgr,'f-1','p-1');
  assert.equal(same.caseId,opened.caseId);
});

test('case opening rejects payment that is not confirmed',async()=>{
  const repo=new CaseRepo(); repo.payment.status='PENDING';
  const svc=new PersistentDciecmsService({repository:repo});
  await assert.rejects(()=>svc.openCase(regMgr,'f-1','p-1'),/CONFIRMED/i);
});

test('case opening rejects payment belonging to another filing assessment',async()=>{
  const repo=new CaseRepo(); repo.assessment.filingId='f-other';
  const svc=new PersistentDciecmsService({repository:repo});
  await assert.rejects(()=>svc.openCase(regMgr,'f-1','p-1'),/filing|assessment|payment/i);
});

test('case opening migration creates transactional case sequence and one-case-per-filing controls',()=>{
  const sql=fs.readFileSync(path.join(process.cwd(),'db/migrations/0006_case_opening.sql'),'utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS case_mgmt\.case_number_sequences/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS case_mgmt\.cases/i);
  assert.match(sql,/filing_id uuid NOT NULL UNIQUE REFERENCES registry\.filings/i);
  assert.match(sql,/case_number varchar\(120\) NOT NULL UNIQUE/i);
  assert.match(sql,/status varchar\(40\) NOT NULL DEFAULT 'AWAITING_ASSIGNMENT'/i);
});
