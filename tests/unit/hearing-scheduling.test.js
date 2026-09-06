'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveActorFromClaims}=require('../../packages/auth');
const {JudicialOperationsService}=require('../../services/api/src/judicial-operations-service');

const COURT_A='11111111-1111-1111-1111-111111111111';
const COURT_B='22222222-2222-2222-2222-222222222222';
const CASE_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HEARING_A='dddddddd-dddd-dddd-dddd-dddddddddddd';
const mag=resolveActorFromClaims({sub:'mag-a',roles:['MAG'],court_ids:[COURT_A]});
const cmag=resolveActorFromClaims({sub:'cmag-a',roles:['CMAG'],court_ids:[COURT_A]});
const cmagB=resolveActorFromClaims({sub:'cmag-b',roles:['CMAG'],court_ids:[COURT_B]});

class HearingRepository {
  constructor(){
    this.case={caseId:CASE_A,caseNumber:'POM-CIVIL-2026-000001',courtId:COURT_A,status:'ASSIGNED',assignedToSubject:'mag-a'};
    this.hearings=new Map();
    this.history=[];
  }
  async getCase(id){return id===CASE_A?Object.freeze({...this.case}):null;}
  async createHearing(input){
    const row={hearingId:input.hearingId,caseId:input.caseId,courtId:input.courtId,hearingType:input.hearingType,status:'SCHEDULED',scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,courtroom:input.courtroom||null,scheduledBy:input.actorSubject,createdAt:input.createdAt};
    this.hearings.set(row.hearingId,row); return Object.freeze({...row});
  }
  async getHearing(id){const row=this.hearings.get(id);return row?Object.freeze({...row}):null;}
  async adjournHearing({hearingId,reason,nextStart,nextEnd,actorSubject,at}){
    const row=this.hearings.get(hearingId);
    if(!row||!['SCHEDULED','IN_PROGRESS'].includes(row.status)){const e=new Error('bad hearing state');e.code='HEARING_STATE_CONFLICT';throw e;}
    this.history.push(Object.freeze({hearingId,fromStart:row.scheduledStart,fromEnd:row.scheduledEnd,reason,nextStart,nextEnd,actorSubject,at}));
    row.status='ADJOURNED'; row.adjournmentReason=reason; row.adjournedBy=actorSubject; row.adjournedAt=at; row.nextStart=nextStart||null; row.nextEnd=nextEnd||null;
    return Object.freeze({...row});
  }
  async listDailyHearings({courtIds,date}){
    return [...this.hearings.values()].filter(h=>courtIds.includes(h.courtId)&&h.scheduledStart.startsWith(date)).map(h=>Object.freeze({...h}));
  }
}

const scheduleInput={hearingType:'MENTION',scheduledStart:'2026-09-07T09:00:00.000Z',scheduledEnd:'2026-09-07T09:30:00.000Z',courtroom:'Courtroom 1'};

test('assigned MAG schedules a hearing for own case within court scope',async()=>{
  const svc=new JudicialOperationsService({repository:new HearingRepository()});
  const hearing=await svc.scheduleHearing(mag,CASE_A,scheduleInput);
  assert.equal(hearing.caseId,CASE_A);
  assert.equal(hearing.status,'SCHEDULED');
  assert.equal(hearing.scheduledBy,'mag-a');
});

test('MAG cannot schedule a hearing for a case assigned to another magistrate',async()=>{
  const repo=new HearingRepository(); repo.case.assignedToSubject='mag-other';
  const svc=new JudicialOperationsService({repository:repo});
  await assert.rejects(()=>svc.scheduleHearing(mag,CASE_A,scheduleInput),/assigned|access/i);
});

test('cross-court hearing scheduling is denied',async()=>{
  const svc=new JudicialOperationsService({repository:new HearingRepository()});
  await assert.rejects(()=>svc.scheduleHearing(cmagB,CASE_A,scheduleInput),/court scope|outside court/i);
});

test('adjournment requires a reason and records immutable history evidence',async()=>{
  const repo=new HearingRepository();
  const svc=new JudicialOperationsService({repository:repo});
  const hearing=await svc.scheduleHearing(cmag,CASE_A,scheduleInput);
  await assert.rejects(()=>svc.adjournHearing(cmag,hearing.hearingId,{reason:''}),/reason/i);
  const adjourned=await svc.adjournHearing(cmag,hearing.hearingId,{reason:'Witness unavailable',nextStart:'2026-09-14T09:00:00.000Z',nextEnd:'2026-09-14T09:30:00.000Z'});
  assert.equal(adjourned.status,'ADJOURNED');
  assert.equal(repo.history.length,1);
  assert.equal(repo.history[0].reason,'Witness unavailable');
  assert.equal(repo.history[0].fromStart,'2026-09-07T09:00:00.000Z');
});

test('adjournment rejects malformed next dates as validation errors',async()=>{
  const repo=new HearingRepository();
  const svc=new JudicialOperationsService({repository:repo});
  const hearing=await svc.scheduleHearing(cmag,CASE_A,scheduleInput);
  await assert.rejects(
    ()=>svc.adjournHearing(cmag,hearing.hearingId,{reason:'Reset',nextStart:'not-a-date',nextEnd:'2026-09-14T09:30:00.000Z'}),
    (error)=>error && error.name==='ValidationError' && /schedule is invalid/i.test(error.message)
  );
  assert.equal(repo.history.length,0);
});

test('daily list returns hearings only within actor court scope and requested date',async()=>{
  const repo=new HearingRepository();
  const svc=new JudicialOperationsService({repository:repo});
  await svc.scheduleHearing(cmag,CASE_A,scheduleInput);
  const rows=await svc.listDailyHearings(cmag,{date:'2026-09-07'});
  assert.equal(rows.length,1);
  assert.equal(rows[0].courtId,COURT_A);
  const otherDate=await svc.listDailyHearings(cmag,{date:'2026-09-08'});
  assert.equal(otherDate.length,0);
});
