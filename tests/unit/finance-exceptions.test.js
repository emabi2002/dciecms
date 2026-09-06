'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveActorFromClaims}=require('../../packages/auth');
const {FinanceOperationsService}=require('../../services/api/src/finance-operations-service');

const COURT_A='11111111-1111-1111-1111-111111111111';
const fin=resolveActorFromClaims({sub:'fin-a',roles:['FIN'],court_ids:[COURT_A]});
const finMgr=resolveActorFromClaims({sub:'fin-mgr-a',roles:['FIN-MGR'],court_ids:[COURT_A]});
const finMgrMaker=resolveActorFromClaims({sub:'fin-maker',roles:['FIN','FIN-MGR'],court_ids:[COURT_A]});

class ExceptionRepo {
  constructor(){
    this.payment={paymentId:'p-1',assessmentId:'a-1',courtId:COURT_A,amountMinor:12500,currency:'PGK',status:'CONFIRMED',providerReference:'PROV-1'};
    this.exceptions=[];
    this.next=1;
    this.duplicate=null;
  }
  async getPayment(id){return id===this.payment.paymentId?this.payment:null;}
  async findPaymentByProviderReference(ref){return this.duplicate&&ref===this.duplicate.providerReference?this.duplicate:null;}
  async createPaymentException(input){const row=Object.freeze({exceptionId:`ex-${this.next++}`,status:'OPEN',resolvedBy:null,resolvedAt:null,resolutionNote:null,...input});this.exceptions.push(row);return row;}
  async listPaymentExceptions({courtIds,status}){return this.exceptions.filter(x=>courtIds.includes(x.courtId)&&(!status||x.status===status));}
  async getPaymentException(id){return this.exceptions.find(x=>x.exceptionId===id)||null;}
  async resolvePaymentException({exceptionId,actorSubject,at,resolutionNote}){
    const i=this.exceptions.findIndex(x=>x.exceptionId===exceptionId&&x.status==='OPEN'&&x.createdBy!==actorSubject);
    if(i<0){const e=new Error('Payment exception was not resolvable');e.code='PAYMENT_EXCEPTION_STATE_CONFLICT';throw e;}
    const row=Object.freeze({...this.exceptions[i],status:'RESOLVED',resolvedBy:actorSubject,resolvedAt:at,resolutionNote});this.exceptions[i]=row;return row;
  }
}

test('amount and currency mismatches create server-derived finance exception evidence',async()=>{
  const repo=new ExceptionRepo();
  const svc=new FinanceOperationsService({repository:repo});
  const result=await svc.inspectPaymentObservation(fin,'p-1',{providerReference:'PROV-1',amountMinor:12000,currency:'USD',evidence:{source:'manual-review'}});
  assert.deepEqual(result.map(x=>x.reasonCode).sort(),['AMOUNT_MISMATCH','CURRENCY_MISMATCH']);
  assert.equal(repo.exceptions.length,2);
  assert.equal(repo.exceptions[0].courtId,COURT_A);
  assert.equal(repo.exceptions[0].createdBy,'fin-a');
});

test('duplicate provider reference creates exception evidence instead of silently accepting collision',async()=>{
  const repo=new ExceptionRepo();
  repo.duplicate={paymentId:'p-other',courtId:COURT_A,providerReference:'PROV-DUP'};
  const svc=new FinanceOperationsService({repository:repo});
  const result=await svc.inspectPaymentObservation(fin,'p-1',{providerReference:'PROV-DUP',amountMinor:12500,currency:'PGK'});
  assert.equal(result.length,1);
  assert.equal(result[0].reasonCode,'DUPLICATE_PROVIDER_REFERENCE');
  assert.equal(result[0].evidence.conflictingPaymentId,'p-other');
});

test('unresolved exception queue is constrained to actor court scope',async()=>{
  const repo=new ExceptionRepo();
  repo.exceptions.push(Object.freeze({exceptionId:'ex-open',paymentId:'p-1',courtId:COURT_A,reasonCode:'AMOUNT_MISMATCH',status:'OPEN',createdBy:'fin-a'}));
  const rows=await new FinanceOperationsService({repository:repo}).listPaymentExceptions(fin,{status:'OPEN'});
  assert.equal(rows.length,1);
  assert.equal(rows[0].exceptionId,'ex-open');
});

test('FIN-MGR resolves an open exception with immutable actor evidence',async()=>{
  const repo=new ExceptionRepo();
  repo.exceptions.push(Object.freeze({exceptionId:'ex-1',paymentId:'p-1',courtId:COURT_A,reasonCode:'AMOUNT_MISMATCH',status:'OPEN',createdBy:'fin-a'}));
  const row=await new FinanceOperationsService({repository:repo}).resolvePaymentException(finMgr,'ex-1',{resolutionNote:'Bank evidence verified'});
  assert.equal(row.status,'RESOLVED');
  assert.equal(row.resolvedBy,'fin-mgr-a');
  assert.equal(row.resolutionNote,'Bank evidence verified');
});

test('same actor cannot create and resolve a payment exception even when actor has both finance roles',async()=>{
  const repo=new ExceptionRepo();
  repo.exceptions.push(Object.freeze({exceptionId:'ex-1',paymentId:'p-1',courtId:COURT_A,reasonCode:'CURRENCY_MISMATCH',status:'OPEN',createdBy:'fin-maker'}));
  await assert.rejects(()=>new FinanceOperationsService({repository:repo}).resolvePaymentException(finMgrMaker,'ex-1',{resolutionNote:'self approval'}),/same actor|maker|checker|resolve/i);
});
