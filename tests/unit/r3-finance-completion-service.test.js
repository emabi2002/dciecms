'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { AccessDeniedError } = require('../../packages/rbac');
const { ValidationError, ConflictError } = require('../../services/api/src/dciecms-service');

function loadService(){ return require('../../services/api/src/finance-completion-service').FinanceCompletionService; }
function actor(sub, role, courts=['COURT-A']) { return resolveActorFromClaims({ sub, roles:[role], court_ids:courts, correlation_id:'corr-1' }); }

class MemoryAudit { constructor(){this.events=[];} async append(e){this.events.push(e); return e;} }
class MemoryOutbox { constructor(){this.events=[];} async enqueue(e){this.events.push(e); return e;} }

function baseRepo(){
  const adjustment = { adjustmentId:'adj-1',assessmentId:'assess-1',paymentId:null,courtId:'COURT-A',adjustmentType:'WAIVER',originalAmountMinor:1000,amountDeltaMinor:-1000,resultingAmountMinor:0,currency:'PGK',status:'REQUESTED',reason:'approved waiver',requestedBy:'fin-a',requestedAt:'2026-09-07T00:00:00.000Z' };
  let refund = { refundRequestId:'refund-1',paymentId:'pay-1',courtId:'COURT-A',amountMinor:500,currency:'PGK',status:'REQUESTED',reason:'duplicate',requestedBy:'fin-a',requestedAt:'2026-09-07T00:00:00.000Z' };
  const reconciliation = { reconciliationId:'rec-1',paymentId:'pay-1',courtId:'COURT-A',status:'PREPARED',preparedBy:'fin-a',preparedAt:'2026-09-07T00:00:00.000Z' };
  return {
    async getFeeAssessment(id){ return id==='assess-1'?{assessmentId:id,courtId:'COURT-A',amountMinor:1000,currency:'PGK',status:'ASSESSED'}:null; },
    async getPayment(id){ return id==='pay-1'?{paymentId:id,courtId:'COURT-A',assessmentId:'assess-1',amountMinor:1000,currency:'PGK',status:'CONFIRMED'}:null; },
    async getReconciliation(id){ return id==='rec-1'?reconciliation:null; },
    async createFeeSchedule(input){ return {feeScheduleId:input.feeScheduleId,courtId:input.courtId,caseTypeCode:input.caseTypeCode,feeCode:input.feeCode,description:input.description,amountMinor:input.amountMinor,currency:input.currency,effectiveFrom:input.effectiveFrom,effectiveTo:input.effectiveTo,status:'DRAFT',createdBy:input.actorSubject,createdAt:input.at}; },
    async listFeeSchedules({courtIds}){ return [{feeScheduleId:'fs-1',courtId:courtIds[0],caseTypeCode:'CIVIL',feeCode:'FILING',amountMinor:1000,currency:'PGK',status:'ACTIVE'}]; },
    async getFeeSchedule(id){ return id==='fs-1'?{feeScheduleId:id,courtId:'COURT-A',status:'DRAFT'}:null; },
    async activateFeeSchedule(){ return {feeScheduleId:'fs-1',courtId:'COURT-A',status:'ACTIVE'}; },
    async retireFeeSchedule(){ return {feeScheduleId:'fs-1',courtId:'COURT-A',status:'RETIRED'}; },
    async listFinancePayments(){ return [{paymentId:'pay-pending',assessmentId:'assess-1',courtId:'COURT-A',amountMinor:1000,currency:'PGK',status:'PENDING',refundedAmountMinor:0}]; },
    async listRefundRequests(){ return [refund]; },
    async createPaymentAdjustment(){ return adjustment; }, async getPaymentAdjustment(){ return adjustment; },
    async approvePaymentAdjustment(){ return {...adjustment,status:'APPROVED',decidedBy:'mgr-a',decidedAt:'2026-09-07T01:00:00.000Z'}; },
    async rejectPaymentAdjustment(){ return {...adjustment,status:'REJECTED',decidedBy:'mgr-a',decidedAt:'2026-09-07T01:00:00.000Z'}; },
    async createRefundRequest(){ return refund; }, async getRefundRequest(){ return refund; },
    async approveRefundRequest(){ refund={...refund,status:'APPROVED',decidedBy:'mgr-a',decidedAt:'2026-09-07T01:00:00.000Z'}; return refund; },
    async rejectRefundRequest(){ refund={...refund,status:'REJECTED',decidedBy:'mgr-a',decidedAt:'2026-09-07T01:00:00.000Z'}; return refund; },
    async completeRefundRequest(){ refund={...refund,status:'COMPLETED',providerRefundReference:'EXT-1',completedBy:'mgr-a',completedAt:'2026-09-07T02:00:00.000Z'}; return refund; },
    async rejectReconciliation(){ return {...reconciliation,status:'REJECTED',exceptionCode:'BANK_MISMATCH',rejectionReason:'difference',rejectedBy:'mgr-a',rejectedAt:'2026-09-07T01:00:00.000Z'}; },
    async listReconciliationExceptions(){ return [{...reconciliation,status:'REJECTED',exceptionCode:'BANK_MISMATCH'}]; }
  };
}

function makeService(repo=baseRepo()){
  const Service=loadService(); const audit=new MemoryAudit(); const outbox=new MemoryOutbox();
  return { service:new Service({repository:repo,auditStore:audit,outboxStore:outbox,clock:()=>new Date('2026-09-07T03:00:00Z'),uuid:()=> 'generated-id'}), audit,outbox };
}

test('service module exposes FinanceCompletionService', () => assert.equal(typeof loadService(),'function'));

test('finance manager creates a validated court-scoped fee schedule; FIN can list schedules', async () => {
  const {service,audit}=makeService();
  const created=await service.createFeeSchedule(actor('mgr-a','FIN-MGR'),{courtId:'COURT-A',caseTypeCode:'civil',feeCode:'filing',description:'Civil filing',amountMinor:1200,currency:'pgk',effectiveFrom:'2026-09-01'});
  assert.equal(created.amountMinor,1200); assert.equal(created.currency,'PGK'); assert.equal(audit.events.at(-1).action,'finance.fee_schedule.create');
  const rows=await service.listFeeSchedules(actor('fin-a','FIN')); assert.equal(rows.length,1);
  await assert.rejects(()=>service.createFeeSchedule(actor('mgr-a','FIN-MGR'),{courtId:'COURT-B',caseTypeCode:'CIVIL',feeCode:'FILING',description:'x',amountMinor:1,effectiveFrom:'2026-09-01'}), AccessDeniedError);
});

test('finance workbench lists court-scoped payment status and refund queues with audited access', async () => {
  const repo=baseRepo(); const calls=[];
  repo.listFinancePayments=async input=>{ calls.push(['payments',input]); return [{paymentId:'pay-pending',courtId:'COURT-A',status:'PENDING'}]; };
  repo.listRefundRequests=async input=>{ calls.push(['refunds',input]); return [{refundRequestId:'refund-1',courtId:'COURT-A',status:'REQUESTED'}]; };
  const {service,audit}=makeService(repo);
  const fin=actor('fin-a','FIN',['COURT-A','COURT-B']);
  const payments=await service.listFinancePayments(fin,{status:'PENDING'});
  const refunds=await service.listRefunds(fin,{status:'REQUESTED'});
  assert.equal(payments[0].status,'PENDING'); assert.equal(refunds[0].status,'REQUESTED');
  assert.deepEqual(calls,[
    ['payments',{courtIds:['COURT-A','COURT-B'],status:'PENDING'}],
    ['refunds',{courtIds:['COURT-A','COURT-B'],status:'REQUESTED'}]
  ]);
  assert.deepEqual(audit.events.slice(-2).map(e=>e.action),['finance.payment.queue.view','finance.refund.queue.view']);
});

test('finance workbench accepts cancelled refund queue state supported by persistence', async () => {
  const repo=baseRepo(); let received=null;
  repo.listRefundRequests=async input=>{ received=input; return [{refundRequestId:'refund-cancelled',courtId:'COURT-A',status:'CANCELLED'}]; };
  const {service}=makeService(repo);
  const rows=await service.listRefunds(actor('fin-a','FIN'),{status:'CANCELLED'});
  assert.equal(rows[0].status,'CANCELLED');
  assert.deepEqual(received,{courtIds:['COURT-A'],status:'CANCELLED'});
});

test('finance workbench rejects unknown payment or refund queue states before repository access', async () => {
  const repo=baseRepo(); let calls=0;
  repo.listFinancePayments=async()=>{calls++;return [];}; repo.listRefundRequests=async()=>{calls++;return [];};
  const {service}=makeService(repo); const fin=actor('fin-a','FIN');
  await assert.rejects(()=>service.listFinancePayments(fin,{status:'SOMETHING_ELSE'}), ValidationError);
  await assert.rejects(()=>service.listRefunds(fin,{status:'SOMETHING_ELSE'}), ValidationError);
  assert.equal(calls,0);
});

test('adjustment request is validated; requester cannot approve own adjustment; approved event excludes reason', async () => {
  const {service,outbox}=makeService();
  const requested=await service.requestPaymentAdjustment(actor('fin-a','FIN'),'assess-1',{adjustmentType:'waiver',amountDeltaMinor:-1000,reason:'approved waiver'});
  assert.equal(requested.status,'REQUESTED');
  await assert.rejects(()=>service.approvePaymentAdjustment(actor('fin-a','FIN-MGR'),'adj-1',{decisionReason:'self'}), AccessDeniedError);
  const approved=await service.approvePaymentAdjustment(actor('mgr-a','FIN-MGR'),'adj-1',{decisionReason:'independent approval'});
  assert.equal(approved.status,'APPROVED');
  const event=outbox.events.at(-1); assert.equal(event.eventType,'finance.adjustment.approved');
  assert.equal('reason' in event.payload,false); assert.equal('decisionReason' in event.payload,false);
});

test('refund workflow is court-scoped, maker-checker and provider-neutral completion evidence only', async () => {
  const {service,outbox}=makeService();
  const requested=await service.requestRefund(actor('fin-a','FIN'),'pay-1',{amountMinor:500,reason:'duplicate'}); assert.equal(requested.status,'REQUESTED');
  await assert.rejects(()=>service.approveRefund(actor('fin-a','FIN-MGR'),'refund-1',{decisionReason:'self'}), AccessDeniedError);
  const approved=await service.approveRefund(actor('mgr-a','FIN-MGR'),'refund-1',{decisionReason:'checked'}); assert.equal(approved.status,'APPROVED');
  const completed=await service.completeRefund(actor('mgr-a','FIN-MGR'),'refund-1',{providerRefundReference:'EXT-1'}); assert.equal(completed.status,'COMPLETED');
  assert.deepEqual(outbox.events.map(e=>e.eventType),['finance.refund.approved','finance.refund.completed']);
  for (const event of outbox.events) { assert.equal('reason' in event.payload,false); assert.equal('providerRefundReference' in event.payload,false); }
});

test('cross-court direct refund identifiers are denied before data is returned', async () => {
  const {service}=makeService();
  await assert.rejects(()=>service.getRefund(actor('fin-b','FIN',['COURT-B']),'refund-1'), AccessDeniedError);
});

test('refund validates positive integer minor units and confirmed source payment', async () => {
  const {service}=makeService();
  await assert.rejects(()=>service.requestRefund(actor('fin-a','FIN'),'pay-1',{amountMinor:1.5,reason:'x'}), ValidationError);
  const repo=baseRepo(); repo.getPayment=async()=>({paymentId:'pay-1',courtId:'COURT-A',amountMinor:1000,currency:'PGK',status:'PENDING'});
  const {service:pending}=makeService(repo);
  await assert.rejects(()=>pending.requestRefund(actor('fin-a','FIN'),'pay-1',{amountMinor:100,reason:'x'}), ConflictError);
});

test('reconciliation rejection enforces maker-checker and exceptions read is court scoped and audited', async () => {
  const {service,outbox,audit}=makeService();
  await assert.rejects(()=>service.rejectReconciliation(actor('fin-a','FIN-MGR'),'rec-1',{reason:'difference',exceptionCode:'BANK_MISMATCH'}), AccessDeniedError);
  const rejected=await service.rejectReconciliation(actor('mgr-a','FIN-MGR'),'rec-1',{reason:'difference',exceptionCode:'BANK_MISMATCH'}); assert.equal(rejected.status,'REJECTED');
  const rows=await service.listReconciliationExceptions(actor('fin-a','FIN')); assert.equal(rows.length,1);
  assert.equal(audit.events.at(-1).action,'finance.reconciliation.exception.view');
  assert.equal(outbox.events.at(-1).eventType,'finance.reconciliation.rejected'); assert.equal('reason' in outbox.events.at(-1).payload,false);
});
