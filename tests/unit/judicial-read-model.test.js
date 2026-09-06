'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveActorFromClaims}=require('../../packages/auth');
const {JudicialWorkbenchService}=require('../../services/api/src/judicial-workbench-service');

const COURT_A='11111111-1111-1111-1111-111111111111';
const COURT_B='22222222-2222-2222-2222-222222222222';
const CASE_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HEARING_A='dddddddd-dddd-dddd-dddd-dddddddddddd';
const JUDGMENT_A='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const mag=resolveActorFromClaims({sub:'mag-a',roles:['MAG'],court_ids:[COURT_A]});
const magB=resolveActorFromClaims({sub:'mag-b',roles:['MAG'],court_ids:[COURT_B]});

class ReadRepository {
  constructor(){
    this.case={caseId:CASE_A,caseNumber:'POM-CIVIL-2026-000001',courtId:COURT_A,status:'ASSIGNED',assignedToSubject:'mag-a'};
    this.hearing={hearingId:HEARING_A,caseId:CASE_A,courtId:COURT_A,status:'COMPLETED',hearingType:'MENTION',scheduledStart:'2026-09-07T09:00:00.000Z',scheduledEnd:'2026-09-07T09:30:00.000Z',outcomeCode:'DECISION_RESERVED'};
    this.judgment={judgmentId:JUDGMENT_A,caseId:CASE_A,hearingId:HEARING_A,courtId:COURT_A,status:'DRAFT',decisionType:'JUDGMENT',title:'Decision',content:'Reasons.',version:1};
  }
  async getCase(id){return id===CASE_A?Object.freeze({...this.case}):null;}
  async getHearing(id){return id===HEARING_A?Object.freeze({...this.hearing}):null;}
  async getJudgment(id){return id===JUDGMENT_A?Object.freeze({...this.judgment}):null;}
  async listPendingJudgments({courtIds,assigneeSubject}){
    return courtIds.includes(COURT_A)&&assigneeSubject==='mag-a'?[Object.freeze({...this.judgment})]:[];
  }
}

test('MAG reads only own assigned case detail',async()=>{
  const svc=new JudicialWorkbenchService({repository:new ReadRepository()});
  const row=await svc.getJudicialCase(mag,CASE_A);
  assert.equal(row.caseNumber,'POM-CIVIL-2026-000001');
  await assert.rejects(()=>svc.getJudicialCase(magB,CASE_A),/court|assigned|access/i);
});

test('MAG reads hearing detail only through assigned case access',async()=>{
  const svc=new JudicialWorkbenchService({repository:new ReadRepository()});
  const row=await svc.getJudicialHearing(mag,HEARING_A);
  assert.equal(row.hearingId,HEARING_A);
  await assert.rejects(()=>svc.getJudicialHearing(magB,HEARING_A),/court|assigned|access/i);
});

test('MAG reads judgment detail only through assigned case access',async()=>{
  const svc=new JudicialWorkbenchService({repository:new ReadRepository()});
  const row=await svc.getJudgment(mag,JUDGMENT_A);
  assert.equal(row.judgmentId,JUDGMENT_A);
  await assert.rejects(()=>svc.getJudgment(magB,JUDGMENT_A),/court|assigned|access/i);
});

test('pending decisions queue is constrained to actor court scope and assignment',async()=>{
  const svc=new JudicialWorkbenchService({repository:new ReadRepository()});
  const mine=await svc.listPendingDecisions(mag);
  assert.equal(mine.length,1);
  assert.equal(mine[0].status,'DRAFT');
  assert.equal((await svc.listPendingDecisions(magB)).length,0);
});
