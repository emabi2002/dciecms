'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveActorFromClaims}=require('../../packages/auth');
const {PersistentDciecmsService}=require('../../services/api/src/persistent-dciecms-service');
const {JudicialOperationsService}=require('../../services/api/src/judicial-operations-service');
const {NotificationService,notificationIdempotencyKey}=require('../../services/api/src/notification-service');

const COURT='11111111-1111-1111-1111-111111111111';
const regMgr=resolveActorFromClaims({sub:'reg-mgr',roles:['REG-MGR'],court_ids:[COURT]});
const finMgr=resolveActorFromClaims({sub:'fin-mgr',roles:['FIN-MGR'],court_ids:[COURT]});
const mag=resolveActorFromClaims({sub:'mag-a',roles:['MAG'],court_ids:[COURT]});

class CapturingPersistent extends PersistentDciecmsService{
  constructor(repo){super({repository:repo});this.events=[];}
  async _queueWorkflowNotification(actor,event){this.events.push({actor,event});}
}
class CapturingJudicial extends JudicialOperationsService{
  constructor(repo){super({repository:repo});this.events=[];}
  async _queueWorkflowNotification(actor,event){this.events.push({actor,event});}
}

test('filing acceptance and return emit notification intents only after authoritative transition',async()=>{
  const filings={f1:{filingId:'f1',courtId:COURT,status:'VALIDATED',filerPartyId:'party-1'},f2:{filingId:'f2',courtId:COURT,status:'SUBMITTED',filerPartyId:'party-2'}};
  const repo={
    async getFiling(id){return filings[id];},
    async transitionFiling({filingId,toStatus}){filings[filingId]={...filings[filingId],status:toStatus};return filings[filingId];}
  };
  const svc=new CapturingPersistent(repo);
  await svc.acceptFiling(regMgr,'f1');
  await svc.returnFiling(regMgr,'f2','missing attachment');
  assert.deepEqual(svc.events.map(x=>x.event.eventType),['filing.accepted','filing.returned']);
  assert.deepEqual(svc.events.map(x=>x.event.resourceId),['f1','f2']);
});

test('payment confirmation and receipt issuance emit high-value notification intents',async()=>{
  const payment={paymentId:'p1',assessmentId:'a1',courtId:COURT,status:'PENDING',amountMinor:1000,currency:'PGK'};
  const confirmed={...payment,status:'CONFIRMED',providerReference:'BANK-1'};
  const repo={
    async getPayment(){return payment.status==='PENDING'?payment:confirmed;},
    async confirmPayment(){payment.status='CONFIRMED';return confirmed;},
    async getReceiptByPayment(){return null;},
    async createReceipt(){return {receiptId:'r1',paymentId:'p1',courtId:COURT,status:'ISSUED',amountMinor:1000,currency:'PGK'};}
  };
  const svc=new CapturingPersistent(repo);
  await svc.confirmPayment(finMgr,'p1','BANK-1');
  await svc.issueReceipt(finMgr,'p1');
  assert.deepEqual(svc.events.map(x=>x.event.eventType),['payment.confirmed','receipt.issued']);
});

test('hearing scheduling adjournment and judgment issuance emit notification intents',async()=>{
  const courtCase={caseId:'c1',courtId:COURT,status:'ASSIGNED',assignedToSubject:'mag-a'};
  const hearing={hearingId:'h1',caseId:'c1',courtId:COURT,status:'SCHEDULED'};
  const judgment={judgmentId:'j1',caseId:'c1',courtId:COURT,status:'SIGNED'};
  const repo={
    async getCase(){return courtCase;},
    async createHearing(input){return {...hearing,hearingId:input.hearingId};},
    async getHearing(){return hearing;},
    async adjournHearing(){return {hearing:{...hearing,status:'ADJOURNED'},nextHearing:null};},
    async getJudgment(){return judgment;},
    async issueJudgment(){return {...judgment,status:'ISSUED'};}
  };
  const svc=new CapturingJudicial(repo);
  await svc.scheduleHearing(mag,'c1',{hearingType:'MENTION',scheduledStart:'2026-09-07T00:00:00Z',scheduledEnd:'2026-09-07T01:00:00Z'});
  await svc.adjournHearing(mag,'h1',{reason:'Further evidence required'});
  await svc.issueJudgment(mag,'j1');
  assert.deepEqual(svc.events.map(x=>x.event.eventType),['hearing.scheduled','hearing.adjourned','judgment.issued']);
});

test('notification idempotency key is deterministic over event resource recipient and channel',()=>{
  assert.equal(typeof notificationIdempotencyKey,'function');
  const a=notificationIdempotencyKey({eventType:'payment.confirmed',resourceId:'p1',recipient:'party@example.com',channel:'EMAIL'});
  const b=notificationIdempotencyKey({eventType:'payment.confirmed',resourceId:'p1',recipient:'party@example.com',channel:'email'});
  const c=notificationIdempotencyKey({eventType:'payment.confirmed',resourceId:'p2',recipient:'party@example.com',channel:'EMAIL'});
  assert.equal(a,b);assert.notEqual(a,c);
});

test('notification service resolves recipient then queues a deduplicated intent',async()=>{
  const created=[];
  const repo={
    async createNotification(input){const existing=created.find(x=>x.idempotencyKey===input.idempotencyKey);if(existing)return existing;const row={notificationId:`n${created.length+1}`,status:'QUEUED',...input};created.push(row);return row;}
  };
  const svc=new NotificationService({repository:repo,recipientResolver:async event=>({channel:'EMAIL',recipient:`${event.recipientPartyId}@example.test`})});
  const event={eventType:'filing.accepted',resourceId:'f1',courtId:COURT,recipientPartyId:'party1',templateCode:'FILING_ACCEPTED'};
  await svc._queueWorkflowNotification(regMgr,event);
  await svc._queueWorkflowNotification(regMgr,event);
  assert.equal(created.length,1);
  assert.equal(created[0].recipient,'party1@example.test');
  assert.equal(created[0].idempotencyKey.length,64);
});
