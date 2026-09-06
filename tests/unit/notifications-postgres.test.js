'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

function loadRepo(){
  try{return require('../../services/api/src/notification-postgres-repository').NotificationPostgresRepository;}
  catch(error){if(error?.code==='MODULE_NOT_FOUND'&&String(error.message).includes('notification-postgres-repository'))return null;throw error;}
}

const COURT_A='11111111-1111-1111-1111-111111111111';
const NOTIFICATION_ID='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ATTEMPT_ID='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

class FakeQueryable{
  constructor(rows=[]){this.rows=rows;this.calls=[];}
  async query(text,params=[]){this.calls.push({text,params});return {rows:this.rows};}
}

class FakeTxPool{
  constructor(){this.calls=[];this.released=false;this.stage=0;}
  async connect(){
    const self=this;
    return {
      async query(text,params=[]){
        self.calls.push({text,params});
        if(/^SELECT .*FROM notifications\.notifications/i.test(text.replace(/\s+/g,' '))) return {rows:[{notification_id:NOTIFICATION_ID,court_id:COURT_A,channel:'EMAIL',recipient:'a@example.com',template_code:'T',event_type:'E',resource_id:'R',status:'QUEUED',created_by_subject:'fin-a',created_at:'2026-09-06T06:00:00.000Z',last_attempt_at:null,delivered_at:null}]};
        if(/SET status='SENDING'/i.test(text)) return {rows:[{notification_id:NOTIFICATION_ID}]};
        if(/INSERT INTO notifications\.delivery_attempts/i.test(text)) return {rows:[{attempt_id:ATTEMPT_ID,notification_id:NOTIFICATION_ID,outcome:'DELIVERED',provider_message_id:'provider-1',error_code:null,error_message:null,attempted_at:'2026-09-06T06:05:00.000Z'}]};
        if(/SET status=\$2/i.test(text)) return {rows:[{notification_id:NOTIFICATION_ID,court_id:COURT_A,channel:'EMAIL',recipient:'a@example.com',template_code:'T',event_type:'E',resource_id:'R',status:'DELIVERED',created_by_subject:'fin-a',created_at:'2026-09-06T06:00:00.000Z',last_attempt_at:'2026-09-06T06:05:00.000Z',delivered_at:'2026-09-06T06:05:00.000Z'}]};
        return {rows:[]};
      },
      release(){self.released=true;}
    };
  }
}

const NOTIFICATION_ROW={notification_id:NOTIFICATION_ID,court_id:COURT_A,channel:'EMAIL',recipient:'a@example.com',template_code:'PAYMENT_CONFIRMED',event_type:'payment.confirmed',resource_id:'p-1',status:'QUEUED',created_by_subject:'fin-a',created_at:'2026-09-06T06:00:00.000Z',last_attempt_at:null,delivered_at:null};

test('notification migration creates outbox and append-only delivery-attempt evidence',()=>{
  const migration=fs.readFileSync(path.join(__dirname,'../../db/migrations/0012_notifications.sql'),'utf8');
  assert.match(migration,/CREATE SCHEMA IF NOT EXISTS notifications/i);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS notifications\.notifications/i);
  assert.match(migration,/status IN \('QUEUED','SENDING','DELIVERED','FAILED'\)/i);
  assert.match(migration,/channel IN \('EMAIL','SMS'\)/i);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS notifications\.delivery_attempts/i);
  assert.match(migration,/REVOKE UPDATE, DELETE ON notifications\.delivery_attempts/i);
});

test('notification repository extends R3 finance repository chain',()=>{
  assert.equal(typeof loadRepo(),'function');
});

test('notification insert is server-authoritative QUEUED state with bound values',async()=>{
  const Repo=loadRepo();const db=new FakeQueryable([NOTIFICATION_ROW]);const repo=new Repo(db);
  const row=await repo.createNotification({notificationId:NOTIFICATION_ID,courtId:COURT_A,channel:'EMAIL',recipient:'a@example.com',templateCode:'PAYMENT_CONFIRMED',eventType:'payment.confirmed',resourceId:'p-1',createdBy:'fin-a',createdAt:'2026-09-06T06:00:00.000Z'});
  assert.equal(row.status,'QUEUED');
  assert.match(db.calls[0].text,/INSERT INTO notifications\.notifications/i);
  assert.match(db.calls[0].text,/'QUEUED'/i);
  assert.equal(db.calls[0].params.includes('QUEUED'),false);
});

test('notification history query is constrained to supplied court scope and optional filters',async()=>{
  const Repo=loadRepo();const db=new FakeQueryable([NOTIFICATION_ROW]);const repo=new Repo(db);
  const rows=await repo.listNotifications({courtIds:[COURT_A],status:'QUEUED',channel:'EMAIL'});
  assert.equal(rows[0].notificationId,NOTIFICATION_ID);
  assert.match(db.calls[0].text,/court_id = ANY\(\$1::uuid\[\]\)/i);
  assert.match(db.calls[0].text,/status = \$2/i);
  assert.match(db.calls[0].text,/channel = \$3/i);
  assert.deepEqual(db.calls[0].params,[[COURT_A],'QUEUED','EMAIL']);
});

test('delivery attempt transaction moves through SENDING and appends attempt before final state',async()=>{
  const Repo=loadRepo();const db=new FakeTxPool();const repo=new Repo(db);
  const result=await repo.recordDeliveryAttempt({notificationId:NOTIFICATION_ID,outcome:'DELIVERED',providerMessageId:'provider-1',errorCode:null,errorMessage:null,attemptedAt:'2026-09-06T06:05:00.000Z'});
  assert.equal(result.notification.status,'DELIVERED');
  assert.equal(result.attempt.attemptId,ATTEMPT_ID);
  const sql=db.calls.map(c=>c.text.replace(/\s+/g,' ').trim());
  assert.equal(sql[0],'BEGIN');
  assert.match(sql[1],/FOR UPDATE/i);
  assert.match(sql[2],/SET status='SENDING'/i);
  assert.match(sql[3],/INSERT INTO notifications\.delivery_attempts/i);
  assert.match(sql[4],/SET status=\$2/i);
  assert.equal(sql[5],'COMMIT');
  assert.equal(db.released,true);
});
