'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { AuditStore } = require('../../packages/audit');
const { PersistentDciecmsService } = require('../../services/api/src/persistent-dciecms-service');
const { AccessDeniedError } = require('../../packages/rbac');
const { ConflictError } = require('../../services/api/src/dciecms-service');

const actor = resolveActorFromClaims({ sub:'fin-a', roles:['FIN'], court_ids:['COURT-A'] });

function repoFixture(schedule = {}) {
  const calls = [];
  const repo = {
    async getFiling(id) {
      return id === 'filing-1' ? { filingId:id, courtId:'COURT-A', caseTypeCode:'CIVIL', status:'ACCEPTED' } : null;
    },
    async getFeeSchedule(id) {
      if (id !== 'fs-1') return null;
      return {
        feeScheduleId:id,
        courtId:'COURT-A',
        caseTypeCode:'CIVIL',
        feeCode:'FILING',
        amountMinor:1250,
        currency:'PGK',
        effectiveFrom:'2026-01-01',
        effectiveTo:'2026-12-31',
        status:'ACTIVE',
        ...schedule
      };
    },
    async createFeeAssessment(input) {
      calls.push(input);
      return {
        assessmentId:input.assessmentId,
        filingId:input.filingId,
        courtId:input.courtId,
        feeScheduleId:input.feeScheduleId || null,
        amountMinor:input.amountMinor,
        currency:input.currency,
        status:'ASSESSED'
      };
    }
  };
  return { repo, calls };
}

function serviceFor(repo) {
  return new PersistentDciecmsService({ repository:repo, auditStore:new AuditStore() });
}

test('governed fee assessment uses authoritative active fee schedule amount and currency', async () => {
  const {repo,calls}=repoFixture();
  const service=serviceFor(repo);
  const assessment=await service.assessFilingFee(actor,'filing-1',{
    feeScheduleId:'fs-1',
    amountMinor:999999,
    currency:'USD'
  });
  assert.equal(assessment.amountMinor,1250);
  assert.equal(assessment.currency,'PGK');
  assert.equal(assessment.feeScheduleId,'fs-1');
  assert.equal(calls[0].feeScheduleId,'fs-1');
  assert.equal(calls[0].amountMinor,1250);
  assert.equal(calls[0].currency,'PGK');
});

test('fee schedule assessment rejects inactive, wrong-case and wrong-court schedules', async () => {
  for (const [override, ErrorType] of [
    [{status:'DRAFT'}, ConflictError],
    [{caseTypeCode:'CRIMINAL'}, ConflictError],
    [{courtId:'COURT-B'}, AccessDeniedError]
  ]) {
    const {repo}=repoFixture(override);
    const service=serviceFor(repo);
    await assert.rejects(()=>service.assessFilingFee(actor,'filing-1',{feeScheduleId:'fs-1'}), ErrorType);
  }
});

test('fee schedule assessment rejects schedules outside their effective date range', async () => {
  const {repo}=repoFixture({effectiveFrom:'2099-01-01',effectiveTo:null});
  const service=serviceFor(repo);
  await assert.rejects(()=>service.assessFilingFee(actor,'filing-1',{feeScheduleId:'fs-1'}), ConflictError);
});

test('legacy manual fee assessment remains available when no fee schedule is supplied', async () => {
  const {repo,calls}=repoFixture();
  const service=serviceFor(repo);
  const assessment=await service.assessFilingFee(actor,'filing-1',{amountMinor:800,currency:'PGK'});
  assert.equal(assessment.amountMinor,800);
  assert.equal(assessment.feeScheduleId,null);
  assert.equal(calls[0].feeScheduleId,null);
});
