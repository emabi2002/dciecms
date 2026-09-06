'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JudicialPostgresRepository}=require('../../services/api/src/judicial-postgres-repository');

const COURT_A='11111111-1111-1111-1111-111111111111';
const CASE_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HEARING_A='dddddddd-dddd-dddd-dddd-dddddddddddd';
const HEARING_B='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function hearingRow(overrides={}){
  return {hearing_id:HEARING_A,case_id:CASE_A,court_id:COURT_A,hearing_type:'MENTION',status:'SCHEDULED',scheduled_start:'2026-09-07T09:00:00.000Z',scheduled_end:'2026-09-07T09:30:00.000Z',courtroom:'Courtroom 1',scheduled_by_subject:'mag-a',created_at:'2026-09-06T00:00:00.000Z',adjourned_by_subject:null,adjourned_at:null,adjournment_reason:null,...overrides};
}

test('R2 hearing migration creates hearing and append-only adjournment history structures',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../../db/migrations/0008_hearings.sql'),'utf8');
  assert.match(sql,/CREATE SCHEMA IF NOT EXISTS judicial/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS judicial\.hearings/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS judicial\.hearing_adjournments/i);
  assert.match(sql,/REVOKE UPDATE, DELETE ON judicial\.hearing_adjournments FROM PUBLIC/i);
});

test('judicial repository creates and retrieves a scheduled hearing',async()=>{
  const calls=[];
  const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[hearingRow()]};}};
  const repo=new JudicialPostgresRepository(db);
  const created=await repo.createHearing({hearingId:HEARING_A,caseId:CASE_A,courtId:COURT_A,hearingType:'MENTION',scheduledStart:'2026-09-07T09:00:00.000Z',scheduledEnd:'2026-09-07T09:30:00.000Z',courtroom:'Courtroom 1',actorSubject:'mag-a',createdAt:'2026-09-06T00:00:00.000Z'});
  assert.equal(created.status,'SCHEDULED');
  assert.equal(created.caseId,CASE_A);
  assert.match(calls[0].sql,/INSERT INTO judicial\.hearings/i);
  const fetched=await repo.getHearing(HEARING_A);
  assert.equal(fetched.hearingId,HEARING_A);
  assert.match(calls[1].sql,/FROM judicial\.hearings/i);
});

test('adjournment is transactional, preserves history and creates optional next hearing',async()=>{
  const calls=[];
  const client={
    async query(sql,params){
      calls.push({sql,params});
      if(/^BEGIN/.test(sql)||/^COMMIT/.test(sql)||/^ROLLBACK/.test(sql)) return {rows:[]};
      if(/FOR UPDATE/i.test(sql)) return {rows:[hearingRow()]};
      if(/INSERT INTO judicial\.hearing_adjournments/i.test(sql)) return {rows:[]};
      if(/UPDATE judicial\.hearings/i.test(sql)) return {rows:[hearingRow({status:'ADJOURNED',adjourned_by_subject:'mag-a',adjourned_at:'2026-09-06T01:00:00.000Z',adjournment_reason:'Witness unavailable'})]};
      if(/INSERT INTO judicial\.hearings/i.test(sql)) return {rows:[hearingRow({hearing_id:HEARING_B,scheduled_start:'2026-09-14T09:00:00.000Z',scheduled_end:'2026-09-14T09:30:00.000Z'})]};
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release(){}
  };
  const repo=new JudicialPostgresRepository({connect:async()=>client});
  const result=await repo.adjournHearing({hearingId:HEARING_A,reason:'Witness unavailable',nextStart:'2026-09-14T09:00:00.000Z',nextEnd:'2026-09-14T09:30:00.000Z',nextHearingId:HEARING_B,actorSubject:'mag-a',at:'2026-09-06T01:00:00.000Z'});
  assert.equal(result.status,'ADJOURNED');
  assert.equal(result.nextHearing.hearingId,HEARING_B);
  assert.ok(calls.some(c=>/INSERT INTO judicial\.hearing_adjournments/i.test(c.sql)));
  assert.ok(calls.some(c=>/COMMIT/.test(c.sql)));
});

test('daily hearing list is court-scoped and resolves the requested date in PNG local time',async()=>{
  const calls=[];
  const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[hearingRow()]};}};
  const repo=new JudicialPostgresRepository(db);
  const rows=await repo.listDailyHearings({courtIds:[COURT_A],date:'2026-09-07'});
  assert.equal(rows.length,1);
  assert.match(calls[0].sql,/court_id\s*=\s*ANY/i);
  assert.match(calls[0].sql,/Pacific\/Port_Moresby/i);
  assert.deepEqual(calls[0].params,[[COURT_A],'2026-09-07']);
});
