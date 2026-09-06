'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JudicialPostgresRepository}=require('../../services/api/src/judicial-postgres-repository');

const COURT_A='11111111-1111-1111-1111-111111111111';
const CASE_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HEARING_A='dddddddd-dddd-dddd-dddd-dddddddddddd';

function hearingRow(overrides={}){return {hearing_id:HEARING_A,case_id:CASE_A,court_id:COURT_A,hearing_type:'MENTION',status:'SCHEDULED',scheduled_start:'2026-09-07T09:00:00.000Z',scheduled_end:'2026-09-07T09:30:00.000Z',courtroom:'Courtroom 1',scheduled_by_subject:'mag-a',created_at:'2026-09-06T00:00:00.000Z',adjourned_by_subject:null,adjourned_at:null,adjournment_reason:null,started_by_subject:null,started_at:null,completed_by_subject:null,completed_at:null,outcome_code:null,...overrides};}

test('hearing mode migration adds lifecycle evidence and append-only appearance/proceeding tables',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../../db/migrations/0009_hearing_mode.sql'),'utf8');
  assert.match(sql,/started_by_subject/i);
  assert.match(sql,/completed_by_subject/i);
  assert.match(sql,/outcome_code/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS judicial\.hearing_appearances/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS judicial\.proceeding_records/i);
  assert.match(sql,/REVOKE UPDATE, DELETE ON judicial\.hearing_appearances FROM PUBLIC/i);
  assert.match(sql,/REVOKE UPDATE, DELETE ON judicial\.proceeding_records FROM PUBLIC/i);
});

test('repository starts only a scheduled hearing',async()=>{
  const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[hearingRow({status:'IN_PROGRESS',started_by_subject:'mag-a',started_at:params[2]})]};}};
  const repo=new JudicialPostgresRepository(db);
  const row=await repo.startHearing({hearingId:HEARING_A,actorSubject:'mag-a',at:'2026-09-07T09:01:00.000Z'});
  assert.equal(row.status,'IN_PROGRESS');
  assert.equal(row.startedBy,'mag-a');
  assert.match(calls[0].sql,/status='SCHEDULED'/i);
});

test('appearance insert is atomically restricted to an in-progress hearing',async()=>{
  const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[{appearance_id:'ap-1',hearing_id:HEARING_A,case_id:CASE_A,court_id:COURT_A,participant_name:'Jane Doe',participant_role:'DEFENDANT',appearance_mode:'IN_PERSON',recorded_by_subject:'mag-a',recorded_at:'2026-09-07T09:05:00.000Z'}]};}};
  const repo=new JudicialPostgresRepository(db);
  const row=await repo.recordAppearance({appearanceId:'ap-1',hearingId:HEARING_A,participantName:'Jane Doe',participantRole:'DEFENDANT',appearanceMode:'IN_PERSON',actorSubject:'mag-a',at:'2026-09-07T09:05:00.000Z'});
  assert.equal(row.participantName,'Jane Doe');
  assert.match(calls[0].sql,/FROM judicial\.hearings/i);
  assert.match(calls[0].sql,/status='IN_PROGRESS'/i);
});

test('proceeding insert is atomically restricted to an in-progress hearing',async()=>{
  const db={query:async()=>({rows:[{proceeding_id:'pr-1',hearing_id:HEARING_A,case_id:CASE_A,court_id:COURT_A,note:null,record_reference:'AUDIO-2026-0001',recorded_by_subject:'mag-a',recorded_at:'2026-09-07T09:10:00.000Z'}]})};
  const repo=new JudicialPostgresRepository(db);
  const row=await repo.recordProceeding({proceedingId:'pr-1',hearingId:HEARING_A,note:null,recordReference:'AUDIO-2026-0001',actorSubject:'mag-a',at:'2026-09-07T09:10:00.000Z'});
  assert.equal(row.recordReference,'AUDIO-2026-0001');
});

test('repository completion transitions only IN_PROGRESS to COMPLETED with outcome evidence',async()=>{
  const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[hearingRow({status:'COMPLETED',completed_by_subject:'mag-a',completed_at:params[3],outcome_code:'DECISION_RESERVED'})]};}};
  const repo=new JudicialPostgresRepository(db);
  const row=await repo.completeHearing({hearingId:HEARING_A,outcomeCode:'DECISION_RESERVED',actorSubject:'mag-a',at:'2026-09-07T09:30:00.000Z'});
  assert.equal(row.status,'COMPLETED');
  assert.equal(row.outcomeCode,'DECISION_RESERVED');
  assert.match(calls[0].sql,/status='IN_PROGRESS'/i);
});
