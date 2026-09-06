'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveActorFromClaims}=require('../../packages/auth');

function loadService(){
  try{return require('../../services/api/src/notification-service').NotificationService;}
  catch(error){if(error?.code==='MODULE_NOT_FOUND'&&String(error.message).includes('notification-service'))return null;throw error;}
}

const COURT_A='11111111-1111-1111-1111-111111111111';
const COURT_B='22222222-2222-2222-2222-222222222222';
const fin=resolveActorFromClaims({sub:'fin-a',roles:['FIN'],court_ids:[COURT_A]});
const systemActor={userId:'notification-worker',roles:['SYSTEM'],courtIds:[COURT_A],explicitGrants:[],isSystem:true};

class NotificationRepo{
  constructor(){this.notifications=[];this.attempts=[];this.n=1;this.a=1;}
  async createNotification(input){const row=Object.freeze({notificationId:`n-${this.n++}`,status:'QUEUED',createdAt:'2026-09-06T06:00:00.000Z',...input});this.notifications.push(row);return row;}
  async listNotifications({courtIds,status=null,channel=null}){return this.notifications.filter(x=>courtIds.includes(x.courtId)&&(!status||x.status===status)&&(!channel||x.channel===channel));}
  async getNotification(id){return this.notifications.find(x=>x.notificationId===id)||null;}
  async recordDeliveryAttempt({notificationId,outcome,providerMessageId,errorCode,errorMessage,attemptedAt}){
    const i=this.notifications.findIndex(x=>x.notificationId===notificationId);if(i<0)return null;
    const attempt=Object.freeze({attemptId:`a-${this.a++}`,notificationId,outcome,providerMessageId:providerMessageId||null,errorCode:errorCode||null,errorMessage:errorMessage||null,attemptedAt});
    this.attempts.push(attempt);
    const status=outcome==='DELIVERED'?'DELIVERED':'FAILED';
    const notification=Object.freeze({...this.notifications[i],status,lastAttemptAt:attemptedAt});this.notifications[i]=notification;
    return {notification,attempt};
  }
}

test('R3 exposes a notification service',()=>assert.equal(typeof loadService(),'function'));

test('valid notification intent is persisted in QUEUED state before dispatch',async()=>{
  const NotificationService=loadService(),repo=new NotificationRepo(),svc=new NotificationService({repository:repo});
  const row=await svc.queueNotification(fin,{courtId:COURT_A,channel:'email',recipient:'party@example.com',templateCode:'PAYMENT_CONFIRMED',eventType:'payment.confirmed',resourceId:'p-1'});
  assert.equal(row.status,'QUEUED');
  assert.equal(row.channel,'EMAIL');
  assert.equal(repo.attempts.length,0);
});

test('notification queue rejects invalid channel and incomplete recipient/template/event data',async()=>{
  const NotificationService=loadService(),svc=new NotificationService({repository:new NotificationRepo()});
  await assert.rejects(()=>svc.queueNotification(fin,{courtId:COURT_A,channel:'PUSH',recipient:'x',templateCode:'T',eventType:'E',resourceId:'R'}),/channel/i);
  await assert.rejects(()=>svc.queueNotification(fin,{courtId:COURT_A,channel:'EMAIL',recipient:'',templateCode:'T',eventType:'E',resourceId:'R'}),/recipient/i);
  await assert.rejects(()=>svc.queueNotification(fin,{courtId:COURT_A,channel:'SMS',recipient:'67570000000',templateCode:'',eventType:'E',resourceId:'R'}),/template/i);
  await assert.rejects(()=>svc.queueNotification(fin,{courtId:COURT_A,channel:'SMS',recipient:'67570000000',templateCode:'T',eventType:'',resourceId:'R'}),/event/i);
});

test('notification cannot be queued outside actor court scope',async()=>{
  const NotificationService=loadService(),svc=new NotificationService({repository:new NotificationRepo()});
  await assert.rejects(()=>svc.queueNotification(fin,{courtId:COURT_B,channel:'EMAIL',recipient:'party@example.com',templateCode:'T',eventType:'E',resourceId:'R'}),/court scope|outside court/i);
});

test('notification history is constrained to actor court scope',async()=>{
  const NotificationService=loadService(),repo=new NotificationRepo(),svc=new NotificationService({repository:repo});
  await repo.createNotification({courtId:COURT_A,channel:'EMAIL',recipient:'a@example.com',templateCode:'T',eventType:'E',resourceId:'R1',createdBy:'fin-a'});
  await repo.createNotification({courtId:COURT_B,channel:'SMS',recipient:'67570000000',templateCode:'T',eventType:'E',resourceId:'R2',createdBy:'other'});
  const rows=await svc.listNotifications(fin,{});
  assert.equal(rows.length,1);assert.equal(rows[0].courtId,COURT_A);
});

test('ordinary user cannot self-declare delivery success',async()=>{
  const NotificationService=loadService(),repo=new NotificationRepo(),svc=new NotificationService({repository:repo});
  const n=await repo.createNotification({courtId:COURT_A,channel:'EMAIL',recipient:'a@example.com',templateCode:'T',eventType:'E',resourceId:'R',createdBy:'fin-a'});
  await assert.rejects(()=>svc.recordDeliveryAttempt(fin,n.notificationId,{outcome:'DELIVERED'}),/system|delivery/i);
  assert.equal(repo.attempts.length,0);
});

test('system delivery attempts append evidence and server controls DELIVERED or FAILED state',async()=>{
  const NotificationService=loadService(),repo=new NotificationRepo(),svc=new NotificationService({repository:repo});
  const n=await repo.createNotification({courtId:COURT_A,channel:'EMAIL',recipient:'a@example.com',templateCode:'T',eventType:'E',resourceId:'R',createdBy:'fin-a'});
  let result=await svc.recordDeliveryAttempt(systemActor,n.notificationId,{outcome:'FAILED',errorCode:'TEMP',errorMessage:'temporary failure'});
  assert.equal(result.notification.status,'FAILED');assert.equal(repo.attempts.length,1);
  result=await svc.recordDeliveryAttempt(systemActor,n.notificationId,{outcome:'DELIVERED',providerMessageId:'provider-1'});
  assert.equal(result.notification.status,'DELIVERED');assert.equal(repo.attempts.length,2);
  assert.equal(repo.attempts[0].outcome,'FAILED');assert.equal(repo.attempts[1].outcome,'DELIVERED');
});
