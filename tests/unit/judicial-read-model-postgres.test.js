'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {JudgmentPostgresRepository}=require('../../services/api/src/judgment-postgres-repository');

const COURT_A='11111111-1111-1111-1111-111111111111';
const COURT_B='22222222-2222-2222-2222-222222222222';

function fakeDb(rows){
  return {calls:[],async query(sql,params){this.calls.push({sql,params});return {rows};}};
}

test('listPendingJudgments scopes by court and assignee and excludes issued decisions',async()=>{
  const db=fakeDb([{judgment_id:'j1',case_id:'c1',hearing_id:'h1',court_id:COURT_A,decision_type:'JUDGMENT',title:'Decision',content:'Reasons',status:'DRAFT',version:1,created_by_subject:'mag-a',created_at:new Date(),assigned_to_subject:'mag-a'}]);
  const repo=new JudgmentPostgresRepository(db);
  const rows=await repo.listPendingJudgments({courtIds:[COURT_A,COURT_B],assigneeSubject:'mag-a'});
  assert.equal(rows.length,1);
  assert.equal(rows[0].judgmentId,'j1');
  const call=db.calls[0];
  assert.match(call.sql,/case_mgmt\.cases/i);
  assert.match(call.sql,/assigned_to_subject/i);
  assert.match(call.sql,/status\s+IN\s*\('DRAFT','FINAL','SIGNED'\)/i);
  assert.deepEqual(call.params,[[COURT_A,COURT_B],'mag-a']);
});
