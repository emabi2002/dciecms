'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHttpApp } = require('../../services/api/src/http-app');

const actor = Object.freeze({ userId:'fin-mgr', roles:['FIN-MGR'], courtIds:['COURT-A'], explicitGrants:[] });
async function withService(service, fn) {
  const server = http.createServer(createHttpApp(service, async () => actor));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise(resolve=>server.close(resolve)); }
}
async function request(base, method, path, body) {
  const options={method,headers:{}};
  if (body!==undefined){ options.headers['content-type']='application/json'; options.body=JSON.stringify(body); }
  const response=await fetch(base+path,options); return {response,body:await response.json()};
}

test('HTTP dispatches all governed R3 finance completion routes', async () => {
  const calls=[];
  const service={
    async createFeeSchedule(_a,input){calls.push(['createFeeSchedule',input]);return {feeScheduleId:'fs-1',status:'DRAFT'};},
    async listFeeSchedules(_a,input){calls.push(['listFeeSchedules',input]);return [];},
    async getFeeSchedule(_a,id){calls.push(['getFeeSchedule',id]);return {feeScheduleId:id,status:'DRAFT'};},
    async activateFeeSchedule(_a,id){calls.push(['activateFeeSchedule',id]);return {feeScheduleId:id,status:'ACTIVE'};},
    async retireFeeSchedule(_a,id){calls.push(['retireFeeSchedule',id]);return {feeScheduleId:id,status:'RETIRED'};},
    async requestPaymentAdjustment(_a,id,input){calls.push(['requestPaymentAdjustment',id,input]);return {adjustmentId:'adj-1',assessmentId:id,status:'REQUESTED'};},
    async getPaymentAdjustment(_a,id){calls.push(['getPaymentAdjustment',id]);return {adjustmentId:id,status:'REQUESTED'};},
    async approvePaymentAdjustment(_a,id,input){calls.push(['approvePaymentAdjustment',id,input]);return {adjustmentId:id,status:'APPROVED'};},
    async rejectPaymentAdjustment(_a,id,input){calls.push(['rejectPaymentAdjustment',id,input]);return {adjustmentId:id,status:'REJECTED'};},
    async requestRefund(_a,id,input){calls.push(['requestRefund',id,input]);return {refundRequestId:'refund-1',paymentId:id,status:'REQUESTED'};},
    async getRefund(_a,id){calls.push(['getRefund',id]);return {refundRequestId:id,status:'REQUESTED'};},
    async approveRefund(_a,id,input){calls.push(['approveRefund',id,input]);return {refundRequestId:id,status:'APPROVED'};},
    async rejectRefund(_a,id,input){calls.push(['rejectRefund',id,input]);return {refundRequestId:id,status:'REJECTED'};},
    async completeRefund(_a,id,input){calls.push(['completeRefund',id,input]);return {refundRequestId:id,status:'COMPLETED'};},
    async rejectReconciliation(_a,id,input){calls.push(['rejectReconciliation',id,input]);return {reconciliationId:id,status:'REJECTED'};},
    async listReconciliationExceptions(){calls.push(['listReconciliationExceptions']);return [];}
  };
  await withService(service,async base=>{
    const cases=[
      ['POST','/finance/fee-schedules',{courtId:'COURT-A',caseTypeCode:'CIVIL',feeCode:'FILING',description:'Civil filing',amountMinor:1200,effectiveFrom:'2026-09-01'},201,'DRAFT'],
      ['GET','/finance/fee-schedules?status=ACTIVE',undefined,200,undefined],
      ['GET','/finance/fee-schedules/fs-1',undefined,200,'DRAFT'],
      ['POST','/finance/fee-schedules/fs-1/activate',{},200,'ACTIVE'],
      ['POST','/finance/fee-schedules/fs-1/retire',{},200,'RETIRED'],
      ['POST','/fee-assessments/assess-1/adjustments',{adjustmentType:'WAIVER',amountDeltaMinor:-1000,reason:'waiver'},201,'REQUESTED'],
      ['GET','/finance/adjustments/adj-1',undefined,200,'REQUESTED'],
      ['POST','/finance/adjustments/adj-1/approve',{decisionReason:'approved'},200,'APPROVED'],
      ['POST','/finance/adjustments/adj-2/reject',{decisionReason:'rejected'},200,'REJECTED'],
      ['POST','/payments/pay-1/refunds',{amountMinor:500,reason:'duplicate'},201,'REQUESTED'],
      ['GET','/finance/refunds/refund-1',undefined,200,'REQUESTED'],
      ['POST','/finance/refunds/refund-1/approve',{decisionReason:'approved'},200,'APPROVED'],
      ['POST','/finance/refunds/refund-2/reject',{decisionReason:'rejected'},200,'REJECTED'],
      ['POST','/finance/refunds/refund-1/complete',{providerRefundReference:'EXT-1'},200,'COMPLETED'],
      ['POST','/reconciliations/rec-1/reject',{reason:'bank mismatch',exceptionCode:'BANK_MISMATCH'},200,'REJECTED'],
      ['GET','/finance/reconciliation-exceptions',undefined,200,undefined]
    ];
    for(const [method,path,body,status,state] of cases){
      const result=await request(base,method,path,body); assert.equal(result.response.status,status,`${method} ${path}`);
      if(state) assert.equal(result.body.status,state,`${method} ${path}`);
    }
  });
  assert.deepEqual(calls.map(c=>c[0]),[
    'createFeeSchedule','listFeeSchedules','getFeeSchedule','activateFeeSchedule','retireFeeSchedule',
    'requestPaymentAdjustment','getPaymentAdjustment','approvePaymentAdjustment','rejectPaymentAdjustment',
    'requestRefund','getRefund','approveRefund','rejectRefund','completeRefund','rejectReconciliation','listReconciliationExceptions'
  ]);
  assert.deepEqual(calls[1][1],{status:'ACTIVE'});
});

test('HTTP exposes no provider refund execution or destructive finance route', async () => {
  const service=new Proxy({}, {get(){return async()=>{throw new Error('forbidden route invoked');};}});
  await withService(service,async base=>{
    for(const [method,path] of [
      ['POST','/finance/refunds/refund-1/execute-provider-refund'],
      ['DELETE','/finance/refunds/refund-1'],
      ['DELETE','/finance/adjustments/adj-1'],
      ['DELETE','/finance/fee-schedules/fs-1']
    ]){
      const result=await request(base,method,path); assert.equal(result.response.status,404,`${method} ${path}`); assert.deepEqual(result.body,{error:'not_found'});
    }
  });
});
