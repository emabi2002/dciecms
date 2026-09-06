'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JudgmentPostgresRepository}=require('../../services/api/src/judgment-postgres-repository');

const COURT_A='11111111-1111-1111-1111-111111111111';
const CASE_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HEARING_A='dddddddd-dddd-dddd-dddd-dddddddddddd';
const JUDGMENT_A='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function row(overrides={}){return {judgment_id:JUDGMENT_A,case_id:CASE_A,hearing_id:HEARING_A,court_id:COURT_A,decision_type:'JUDGMENT',title:'Decision',content:'Reasons and orders.',status:'DRAFT',version:1,created_by_subject:'mag-a',created_at:'2026-09-07T10:00:00.000Z',updated_by_subject:null,updated_at:null,reviewed_by_subject:null,reviewed_at:null,signed_by_subject:null,signed_at:null,issued_by_subject:null,issued_at:null,...overrides};}

test('judgment migration creates lifecycle table and database immutability trigger',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../../db/migrations/0010_judgments.sql'),'utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS judicial\.judgments/i);
  assert.match(sql,/DRAFT.*FINAL.*SIGNED.*ISSUED/is);
  assert.match(sql,/enforce_judgment_immutability/i);
  assert.match(sql,/BEFORE UPDATE OR DELETE ON judicial\.judgments/i);
});

test('repository creates and reads a draft judgment',async()=>{
  const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[row()]};}};
  const repo=new JudgmentPostgresRepository(db);
  const created=await repo.createJudgment({judgmentId:JUDGMENT_A,caseId:CASE_A,hearingId:HEARING_A,courtId:COURT_A,decisionType:'JUDGMENT',title:'Decision',content:'Reasons and orders.',actorSubject:'mag-a',at:'2026-09-07T10:00:00.000Z'});
  assert.equal(created.status,'DRAFT');
  assert.match(calls[0].sql,/INSERT INTO judicial\.judgments/i);
  const fetched=await repo.getJudgment(JUDGMENT_A);
  assert.equal(fetched.judgmentId,JUDGMENT_A);
});

test('draft update increments version and is conditional on DRAFT',async()=>{
  const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[row({title:'Revised',content:'Revised reasons.',version:2,updated_by_subject:'mag-a',updated_at:params[3]})]};}};
  const repo=new JudgmentPostgresRepository(db);
  const updated=await repo.updateJudgmentDraft({judgmentId:JUDGMENT_A,title:'Revised',content:'Revised reasons.',actorSubject:'mag-a',at:'2026-09-07T10:05:00.000Z'});
  assert.equal(updated.version,2);
  assert.match(calls[0].sql,/status='DRAFT'/i);
  assert.match(calls[0].sql,/version=version\+1/i);
});

test('review, sign and issue transitions are state-conditional',async()=>{
  const states=['FINAL','SIGNED','ISSUED'];
  let index=0;const calls=[];
  const db={query:async(sql,params)=>{calls.push({sql,params});const status=states[index++];return {rows:[row({status,reviewed_by_subject:status==='FINAL'?'mag-a':null,signed_by_subject:status==='SIGNED'?'mag-a':null,issued_by_subject:status==='ISSUED'?'mag-a':null})]};}};
  const repo=new JudgmentPostgresRepository(db);
  assert.equal((await repo.reviewJudgment({judgmentId:JUDGMENT_A,actorSubject:'mag-a',at:'2026-09-07T10:10:00.000Z'})).status,'FINAL');
  assert.equal((await repo.signJudgment({judgmentId:JUDGMENT_A,actorSubject:'mag-a',at:'2026-09-07T10:11:00.000Z'})).status,'SIGNED');
  assert.equal((await repo.issueJudgment({judgmentId:JUDGMENT_A,actorSubject:'mag-a',at:'2026-09-07T10:12:00.000Z'})).status,'ISSUED');
  assert.match(calls[0].sql,/status='DRAFT'/i);
  assert.match(calls[1].sql,/status='FINAL'/i);
  assert.match(calls[2].sql,/status='SIGNED'/i);
});

test('repository maps a zero-row lifecycle update to JUDGMENT_STATE_CONFLICT',async()=>{
  const repo=new JudgmentPostgresRepository({query:async()=>({rows:[]})});
  await assert.rejects(()=>repo.signJudgment({judgmentId:JUDGMENT_A,actorSubject:'mag-a',at:'2026-09-07T10:11:00.000Z'}),e=>e.code==='JUDGMENT_STATE_CONFLICT');
});
