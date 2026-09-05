'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PostgresRepository}=require('../../services/api/src/postgres-repository');

function makePool(){
  const calls=[];
  const client={
    async query(text,params=[]){
      calls.push({text,params});
      if (/SELECT case_id,case_number/i.test(text)) return {rows:[]};
      if (/SELECT court_code/i.test(text)) return {rows:[{court_code:'POM'}]};
      if (/INSERT INTO case_mgmt\.case_number_sequences/i.test(text)) return {rows:[{last_value:'1'}]};
      if (/INSERT INTO case_mgmt\.cases/i.test(text)) return {rows:[{case_id:'c-1',case_number:'POM-CIVIL-2026-000001',filing_id:'f-1',payment_id:'p-1',court_id:'court-1',case_type_code:'CIVIL',status:'AWAITING_ASSIGNMENT',opened_by_subject:'reg-mgr',opened_at:'2026-09-06T00:00:00Z'}]};
      return {rows:[]};
    },
    release(){calls.push({text:'RELEASE',params:[]});}
  };
  return {pool:{async connect(){return client;}},calls};
}

test('PostgresRepository gets case by filing id using parameterized SQL',async()=>{
  const db={calls:[],async query(text,params=[]){this.calls.push({text,params});return {rows:[{case_id:'c-1',case_number:'POM-CIVIL-2026-000001',filing_id:'f-1',payment_id:'p-1',court_id:'court-1',case_type_code:'CIVIL',status:'AWAITING_ASSIGNMENT',opened_by_subject:'reg-mgr',opened_at:'2026-09-06T00:00:00Z'}]};}};
  const repo=new PostgresRepository(db);
  const row=await repo.getCaseByFiling('f-1');
  assert.equal(row.caseNumber,'POM-CIVIL-2026-000001');
  assert.deepEqual(db.calls[0].params,['f-1']);
});

test('PostgresRepository allocates case number and inserts case in one transaction',async()=>{
  const {pool,calls}=makePool(); const repo=new PostgresRepository(pool);
  const opened=await repo.openCaseFromConfirmedPayment({caseId:'c-1',filingId:'f-1',paymentId:'p-1',courtId:'court-1',caseTypeCode:'CIVIL',actorSubject:'reg-mgr',openedAt:'2026-09-06T00:00:00Z'});
  assert.equal(opened.caseNumber,'POM-CIVIL-2026-000001');
  assert.equal(calls[0].text,'BEGIN');
  assert.match(calls.some(c=>/ON CONFLICT \(court_id,case_type_code,case_year\)/i.test(c.text))? 'yes':'no',/yes/);
  assert.match(calls.find(c=>/INSERT INTO case_mgmt\.cases/i.test(c.text)).text,/RETURNING case_id,case_number/i);
  assert.equal(calls.at(-2).text,'COMMIT');
  assert.equal(calls.at(-1).text,'RELEASE');
});
