'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveActorFromClaims}=require('../../packages/auth');
const {JudicialOperationsService}=require('../../services/api/src/judicial-operations-service');

const COURT_A='11111111-1111-1111-1111-111111111111';
const CASE_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HEARING_A='dddddddd-dddd-dddd-dddd-dddddddddddd';
const mag=resolveActorFromClaims({sub:'mag-a',roles:['MAG'],court_ids:[COURT_A]});
const cmag=resolveActorFromClaims({sub:'cmag-a',roles:['CMAG'],court_ids:[COURT_A]});

class HearingModeRepository {
  constructor(){
    this.case={caseId:CASE_A,courtId:COURT_A,status:'HEARING_SCHEDULED',assignedToSubject:'mag-a'};
    this.hearing={hearingId:HEARING_A,caseId:CASE_A,courtId:COURT_A,status:'SCHEDULED',scheduledStart:'2026-09-07T09:00:00.000Z',scheduledEnd:'2026-09-07T09:30:00.000Z'};
    this.appearances=[];
    this.proceedings=[];
  }
  async getCase(id){return id===CASE_A?Object.freeze({...this.case}):null;}
  async getHearing(id){return id===HEARING_A?Object.freeze({...this.hearing}):null;}
  async startHearing({hearingId,actorSubject,at}){
    if(hearingId!==HEARING_A||this.hearing.status!=='SCHEDULED'){const e=new Error('bad state');e.code='HEARING_STATE_CONFLICT';throw e;}
    this.hearing.status='IN_PROGRESS';this.hearing.startedBy=actorSubject;this.hearing.startedAt=at;return Object.freeze({...this.hearing});
  }
  async recordAppearance(input){
    if(this.hearing.status!=='IN_PROGRESS'){const e=new Error('bad state');e.code='HEARING_STATE_CONFLICT';throw e;}
    const row={appearanceId:input.appearanceId,hearingId:input.hearingId,caseId:CASE_A,courtId:COURT_A,participantName:input.participantName,participantRole:input.participantRole,appearanceMode:input.appearanceMode,recordedBy:input.actorSubject,recordedAt:input.at};
    this.appearances.push(row);return Object.freeze({...row});
  }
  async recordProceeding(input){
    if(this.hearing.status!=='IN_PROGRESS'){const e=new Error('bad state');e.code='HEARING_STATE_CONFLICT';throw e;}
    const row={proceedingId:input.proceedingId,hearingId:input.hearingId,caseId:CASE_A,courtId:COURT_A,note:input.note||null,recordReference:input.recordReference||null,recordedBy:input.actorSubject,recordedAt:input.at};
    this.proceedings.push(row);return Object.freeze({...row});
  }
  async completeHearing({hearingId,outcomeCode,actorSubject,at}){
    if(hearingId!==HEARING_A||this.hearing.status!=='IN_PROGRESS'){const e=new Error('bad state');e.code='HEARING_STATE_CONFLICT';throw e;}
    this.hearing.status='COMPLETED';this.hearing.outcomeCode=outcomeCode;this.hearing.completedBy=actorSubject;this.hearing.completedAt=at;return Object.freeze({...this.hearing});
  }
}

test('assigned MAG starts a scheduled hearing and server records actor/time',async()=>{
  const svc=new JudicialOperationsService({repository:new HearingModeRepository()});
  const started=await svc.startHearing(mag,HEARING_A);
  assert.equal(started.status,'IN_PROGRESS');
  assert.equal(started.startedBy,'mag-a');
  assert.ok(started.startedAt);
});

test('MAG cannot enter hearing mode for another magistrate assigned case',async()=>{
  const repo=new HearingModeRepository();repo.case.assignedToSubject='mag-other';
  const svc=new JudicialOperationsService({repository:repo});
  await assert.rejects(()=>svc.startHearing(mag,HEARING_A),/assigned|access/i);
});

test('appearance can be recorded only during an in-progress hearing',async()=>{
  const repo=new HearingModeRepository();const svc=new JudicialOperationsService({repository:repo});
  await assert.rejects(()=>svc.recordAppearance(mag,HEARING_A,{participantName:'Jane Doe',participantRole:'DEFENDANT',appearanceMode:'IN_PERSON'}),/state|progress/i);
  await svc.startHearing(mag,HEARING_A);
  const row=await svc.recordAppearance(mag,HEARING_A,{participantName:'Jane Doe',participantRole:'DEFENDANT',appearanceMode:'IN_PERSON'});
  assert.equal(row.participantName,'Jane Doe');
  assert.equal(row.recordedBy,'mag-a');
});

test('proceeding record requires either a note or record reference and is actor-stamped',async()=>{
  const repo=new HearingModeRepository();const svc=new JudicialOperationsService({repository:repo});
  await svc.startHearing(mag,HEARING_A);
  await assert.rejects(()=>svc.recordProceeding(mag,HEARING_A,{}),/note|reference/i);
  const row=await svc.recordProceeding(mag,HEARING_A,{recordReference:'AUDIO-2026-0001'});
  assert.equal(row.recordReference,'AUDIO-2026-0001');
  assert.equal(row.recordedBy,'mag-a');
});

test('hearing completion accepts an outcome code but server controls COMPLETED state',async()=>{
  const repo=new HearingModeRepository();const svc=new JudicialOperationsService({repository:repo});
  await svc.startHearing(cmag,HEARING_A);
  await assert.rejects(()=>svc.completeHearing(cmag,HEARING_A,{}),/outcome/i);
  const completed=await svc.completeHearing(cmag,HEARING_A,{outcomeCode:'DECISION_RESERVED'});
  assert.equal(completed.status,'COMPLETED');
  assert.equal(completed.outcomeCode,'DECISION_RESERVED');
  assert.equal(completed.completedBy,'cmag-a');
});
