'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveActorFromClaims}=require('../../packages/auth');
const {JudicialOperationsService}=require('../../services/api/src/judicial-operations-service');

const COURT_A='11111111-1111-1111-1111-111111111111';
const CASE_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HEARING_A='dddddddd-dddd-dddd-dddd-dddddddddddd';
const mag=resolveActorFromClaims({sub:'mag-a',roles:['MAG'],court_ids:[COURT_A]});
const otherMag=resolveActorFromClaims({sub:'mag-b',roles:['MAG'],court_ids:[COURT_A]});

class JudgmentRepository {
  constructor(){
    this.case={caseId:CASE_A,courtId:COURT_A,status:'ASSIGNED',assignedToSubject:'mag-a'};
    this.hearing={hearingId:HEARING_A,caseId:CASE_A,courtId:COURT_A,status:'COMPLETED',outcomeCode:'DECISION_RESERVED'};
    this.judgments=new Map();
  }
  async getCase(id){return id===CASE_A?Object.freeze({...this.case}):null;}
  async getHearing(id){return id===HEARING_A?Object.freeze({...this.hearing}):null;}
  async createJudgment(input){
    const row={judgmentId:input.judgmentId,caseId:input.caseId,hearingId:input.hearingId,courtId:input.courtId,decisionType:input.decisionType,title:input.title,content:input.content,status:'DRAFT',version:1,createdBy:input.actorSubject,createdAt:input.at,reviewedBy:null,reviewedAt:null,signedBy:null,signedAt:null,issuedBy:null,issuedAt:null};
    this.judgments.set(row.judgmentId,row);return Object.freeze({...row});
  }
  async getJudgment(id){const row=this.judgments.get(id);return row?Object.freeze({...row}):null;}
  async updateJudgmentDraft({judgmentId,title,content,actorSubject,at}){
    const row=this.judgments.get(judgmentId);if(!row||row.status!=='DRAFT'){const e=new Error('immutable');e.code='JUDGMENT_STATE_CONFLICT';throw e;}
    row.title=title;row.content=content;row.version+=1;row.updatedBy=actorSubject;row.updatedAt=at;return Object.freeze({...row});
  }
  async reviewJudgment({judgmentId,actorSubject,at}){
    const row=this.judgments.get(judgmentId);if(!row||row.status!=='DRAFT'){const e=new Error('bad state');e.code='JUDGMENT_STATE_CONFLICT';throw e;}
    row.status='FINAL';row.reviewedBy=actorSubject;row.reviewedAt=at;return Object.freeze({...row});
  }
  async signJudgment({judgmentId,actorSubject,at}){
    const row=this.judgments.get(judgmentId);if(!row||row.status!=='FINAL'){const e=new Error('bad state');e.code='JUDGMENT_STATE_CONFLICT';throw e;}
    row.status='SIGNED';row.signedBy=actorSubject;row.signedAt=at;return Object.freeze({...row});
  }
  async issueJudgment({judgmentId,actorSubject,at}){
    const row=this.judgments.get(judgmentId);if(!row||row.status!=='SIGNED'){const e=new Error('bad state');e.code='JUDGMENT_STATE_CONFLICT';throw e;}
    row.status='ISSUED';row.issuedBy=actorSubject;row.issuedAt=at;return Object.freeze({...row});
  }
}

const draftInput={hearingId:HEARING_A,decisionType:'JUDGMENT',title:'Decision',content:'Reasons and orders.'};

test('assigned MAG creates a draft judgment only from a completed hearing for the same case',async()=>{
  const svc=new JudicialOperationsService({repository:new JudgmentRepository()});
  const row=await svc.createJudgment(mag,CASE_A,draftInput);
  assert.equal(row.status,'DRAFT');
  assert.equal(row.createdBy,'mag-a');
  assert.equal(row.hearingId,HEARING_A);
});

test('MAG cannot create a judgment for another magistrate assigned case',async()=>{
  const svc=new JudicialOperationsService({repository:new JudgmentRepository()});
  await assert.rejects(()=>svc.createJudgment(otherMag,CASE_A,draftInput),/assigned|access/i);
});

test('draft may be edited before review but becomes immutable after review/signing',async()=>{
  const repo=new JudgmentRepository();const svc=new JudicialOperationsService({repository:repo});
  const draft=await svc.createJudgment(mag,CASE_A,draftInput);
  const edited=await svc.updateJudgmentDraft(mag,draft.judgmentId,{title:'Revised Decision',content:'Revised reasons.'});
  assert.equal(edited.version,2);
  const final=await svc.reviewJudgment(mag,draft.judgmentId);
  assert.equal(final.status,'FINAL');
  await assert.rejects(()=>svc.updateJudgmentDraft(mag,draft.judgmentId,{title:'Late edit',content:'Not allowed'}),/conflict|immutable|state/i);
});

test('judgment follows FINAL to SIGNED to ISSUED with server actor stamps',async()=>{
  const repo=new JudgmentRepository();const svc=new JudicialOperationsService({repository:repo});
  const draft=await svc.createJudgment(mag,CASE_A,draftInput);
  await svc.reviewJudgment(mag,draft.judgmentId);
  const signed=await svc.signJudgment(mag,draft.judgmentId);
  assert.equal(signed.status,'SIGNED');
  assert.equal(signed.signedBy,'mag-a');
  const issued=await svc.issueJudgment(mag,draft.judgmentId);
  assert.equal(issued.status,'ISSUED');
  assert.equal(issued.issuedBy,'mag-a');
});

test('judgment cannot be signed before review/finalization',async()=>{
  const repo=new JudgmentRepository();const svc=new JudicialOperationsService({repository:repo});
  const draft=await svc.createJudgment(mag,CASE_A,draftInput);
  await assert.rejects(()=>svc.signJudgment(mag,draft.judgmentId),/conflict|state|final/i);
});
