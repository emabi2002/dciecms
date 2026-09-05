'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveActorFromClaims } = require('../../packages/auth');
const { PersistentDciecmsService } = require('../../services/api/src/persistent-dciecms-service');

const fin = resolveActorFromClaims({ sub:'fin-a', roles:['FIN'], court_ids:['COURT-A'] });
const finMgr = resolveActorFromClaims({ sub:'fin-mgr-a', roles:['FIN-MGR'], court_ids:['COURT-A'] });

class FinanceRepo {
  constructor(){
    this.filing={filingId:'f-1',courtId:'COURT-A',status:'ACCEPTED'};
    this.assessment=null;
    this.payment=null;
  }
  async getFiling(id){ return id === 'f-1' ? this.filing : null; }
  async createFeeAssessment(input){
    this.assessment={ assessmentId:input.assessmentId, filingId:input.filingId, courtId:input.courtId, amountMinor:input.amountMinor, currency:input.currency, status:'ASSESSED', assessedBy:input.actorSubject, createdAt:input.at };
    return this.assessment;
  }
  async getFeeAssessment(id){ return this.assessment?.assessmentId === id ? this.assessment : null; }
  async createPayment(input){
    this.payment={ paymentId:input.paymentId, assessmentId:input.assessmentId, courtId:input.courtId, amountMinor:input.amountMinor, currency:input.currency, status:'PENDING', createdAt:input.at, confirmedAt:null, confirmedBy:null, providerReference:null };
    return this.payment;
  }
  async getPayment(id){ return this.payment?.paymentId === id ? this.payment : null; }
  async confirmPayment(input){
    this.payment={...this.payment,status:'CONFIRMED',providerReference:input.providerReference,confirmedAt:input.at,confirmedBy:input.actorSubject};
    return this.payment;
  }
}

test('finance officer can assess an accepted filing fee in PGK minor units', async()=>{
  const svc=new PersistentDciecmsService({repository:new FinanceRepo()});
  const assessment=await svc.assessFilingFee(fin,'f-1',{amountMinor:12500,currency:'PGK'});
  assert.equal(assessment.status,'ASSESSED');
  assert.equal(assessment.amountMinor,12500);
  assert.equal(assessment.currency,'PGK');
});

test('fee assessment rejects non-positive or non-integer minor-unit amounts', async()=>{
  const svc=new PersistentDciecmsService({repository:new FinanceRepo()});
  await assert.rejects(()=>svc.assessFilingFee(fin,'f-1',{amountMinor:0,currency:'PGK'}),/amountMinor/i);
  await assert.rejects(()=>svc.assessFilingFee(fin,'f-1',{amountMinor:12.5,currency:'PGK'}),/amountMinor/i);
});

test('finance officer can create a pending payment only for the assessment amount', async()=>{
  const repo=new FinanceRepo(); const svc=new PersistentDciecmsService({repository:repo});
  const assessment=await svc.assessFilingFee(fin,'f-1',{amountMinor:12500,currency:'PGK'});
  const payment=await svc.createPayment(fin,assessment.assessmentId);
  assert.equal(payment.status,'PENDING');
  assert.equal(payment.amountMinor,12500);
  assert.equal(payment.currency,'PGK');
});

test('only finance manager can record payment confirmation and provider reference is mandatory', async()=>{
  const repo=new FinanceRepo(); const svc=new PersistentDciecmsService({repository:repo});
  const assessment=await svc.assessFilingFee(fin,'f-1',{amountMinor:12500,currency:'PGK'});
  const payment=await svc.createPayment(fin,assessment.assessmentId);
  await assert.rejects(()=>svc.confirmPayment(fin,payment.paymentId,'PGW-1'),/Permission denied|manager/i);
  await assert.rejects(()=>svc.confirmPayment(finMgr,payment.paymentId,''),/providerReference/i);
  const confirmed=await svc.confirmPayment(finMgr,payment.paymentId,'PGW-1');
  assert.equal(confirmed.status,'CONFIRMED');
  assert.equal(confirmed.providerReference,'PGW-1');
  assert.equal(confirmed.confirmedBy,'fin-mgr-a');
});

test('finance migration creates authoritative assessment and payment tables',()=>{
  const sql=fs.readFileSync(path.join(process.cwd(),'db/migrations/0004_finance.sql'),'utf8');
  assert.match(sql,/CREATE SCHEMA IF NOT EXISTS finance/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS finance\.fee_assessments/i);
  assert.match(sql,/amount_minor bigint NOT NULL CHECK \(amount_minor > 0\)/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS finance\.payments/i);
  assert.match(sql,/status varchar\(30\) NOT NULL DEFAULT 'PENDING'/i);
  assert.match(sql,/provider_reference varchar\(160\)/i);
});
