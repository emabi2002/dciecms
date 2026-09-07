'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PostgresRepository } = require('../../services/api/src/postgres-repository');

class FakeQueryable {
  constructor(responses = []) { this.responses = [...responses]; this.calls = []; }
  async query(text, params = []) {
    this.calls.push({ text, params });
    return this.responses.shift() || { rows: [] };
  }
}

test('migration 0015 is additive and denies destructive records operations', () => {
  const migrationPath = path.join(__dirname, '../../db/migrations/0015_case_lifecycle_records.sql');
  assert.equal(fs.existsSync(migrationPath), true, 'migration 0015 must exist');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS records/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS case_mgmt\.case_lifecycle_events/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS records\.case_record_controls/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS records\.disposal_requests/i);
  assert.match(sql, /REVOKE DELETE ON case_mgmt\.case_lifecycle_events FROM PUBLIC/i);
  assert.match(sql, /REVOKE DELETE ON records\.case_record_controls FROM PUBLIC/i);
  assert.match(sql, /REVOKE DELETE ON records\.disposal_requests FROM PUBLIC/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION case_mgmt\.enforce_case_lifecycle_event_immutability\(\)/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON case_mgmt\.case_lifecycle_events/i);
  assert.doesNotMatch(sql, /DROP TABLE/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i);
});

test('PostgresRepository installs case lifecycle and records methods', () => {
  const repo = new PostgresRepository(new FakeQueryable());
  for (const method of [
    'hasActiveCaseHearing',
    'getIssuedJudgmentForCase',
    'disposeCase',
    'closeCase',
    'reopenCase',
    'getCaseRecordControl',
    'assignRetention',
    'archiveCaseRecord',
    'setCaseLegalHold',
    'releaseCaseLegalHold',
    'hasDocumentLegalHold',
    'createDisposalRequest',
    'getDisposalRequest',
    'approveDisposalRequest',
    'rejectDisposalRequest'
  ]) {
    assert.equal(typeof repo[method], 'function', `missing repository method ${method}`);
  }
});

test('active hearing and document legal hold checks are parameterized and fail closed on matching rows', async () => {
  const db = new FakeQueryable([
    { rows: [{ active: true }] },
    { rows: [{ held: true }] }
  ]);
  const repo = new PostgresRepository(db);
  assert.equal(typeof repo.hasActiveCaseHearing, 'function');
  assert.equal(await repo.hasActiveCaseHearing('case-1'), true);
  assert.match(db.calls[0].text, /judicial\.hearings/i);
  assert.match(db.calls[0].text, /SCHEDULED.*IN_PROGRESS|IN_PROGRESS.*SCHEDULED/is);
  assert.deepEqual(db.calls[0].params, ['case-1']);

  assert.equal(await repo.hasDocumentLegalHold('case-1'), true);
  assert.match(db.calls[1].text, /documents\.documents/i);
  assert.match(db.calls[1].text, /legal_hold\s*=\s*true/i);
  assert.deepEqual(db.calls[1].params, ['case-1']);
});

test('disposeCase uses a conditional transition and appends lifecycle evidence', async () => {
  const row = {
    case_id: 'case-1', case_number: 'POM-CIVIL-2026-000001', filing_id: 'filing-1', payment_id: 'pay-1',
    court_id: 'court-1', case_type_code: 'CIVIL', status: 'DISPOSED', opened_by_subject: 'reg-1',
    opened_at: '2026-09-01T00:00:00.000Z', assigned_to_subject: 'mag-1', assigned_by_subject: 'cmag-1',
    assigned_at: '2026-09-02T00:00:00.000Z', disposition_code: 'FINAL_JUDGMENT', disposed_by_subject: 'mag-1',
    disposed_at: '2026-09-07T00:00:00.000Z'
  };
  const db = new FakeQueryable([{ rows: [row] }]);
  const repo = new PostgresRepository(db);
  assert.equal(typeof repo.disposeCase, 'function');
  const result = await repo.disposeCase({
    caseId: 'case-1', dispositionCode: 'FINAL_JUDGMENT', reason: 'Matter finally determined',
    judgmentId: 'judgment-1', actorSubject: 'mag-1', at: '2026-09-07T00:00:00.000Z'
  });
  assert.equal(result.status, 'DISPOSED');
  assert.equal(result.dispositionCode, 'FINAL_JUDGMENT');
  assert.match(db.calls[0].text, /status='ASSIGNED'/i);
  assert.match(db.calls[0].text, /case_mgmt\.case_lifecycle_events/i);
  assert.match(db.calls[0].text, /DISPOSED/i);
  assert.equal(db.calls[0].text.includes('Matter finally determined'), false);
});

test('disposal approval SQL enforces maker checker, closed-case eligibility and no legal hold', async () => {
  const db = new FakeQueryable([{ rows: [{
    disposal_request_id: 'dr-1', case_record_control_id: 'rc-1', case_id: 'case-1', court_id: 'court-1',
    status: 'APPROVED', reason: 'Retention expired', requested_by_subject: 'records-1',
    requested_at: '2026-09-07T00:00:00.000Z', decided_by_subject: 'cmag-1', decided_at: '2033-09-07T00:00:00.000Z',
    decision_reason: 'Approved after review'
  }] }]);
  const repo = new PostgresRepository(db);
  assert.equal(typeof repo.approveDisposalRequest, 'function');
  const result = await repo.approveDisposalRequest({
    disposalRequestId: 'dr-1', actorSubject: 'cmag-1', decisionReason: 'Approved after review', at: '2033-09-07T00:00:00.000Z'
  });
  assert.equal(result.status, 'APPROVED');
  const sql = db.calls[0].text;
  assert.match(sql, /requested_by_subject\s*<>\s*\$2/i);
  assert.match(sql, /legal_hold\s*=\s*false/i);
  assert.match(sql, /disposition_eligible_at\s*<=\s*\$4/i);
  assert.match(sql, /c\.status\s*=\s*'CLOSED'/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i);
});

test('assignRetention uses contiguous SQL placeholders with no unused parameter hole', async () => {
  const db = new FakeQueryable([{ rows: [{
    case_record_control_id: 'rc-1', case_id: 'case-1', court_id: 'court-1', status: 'ACTIVE',
    retention_class_code: 'CIVIL-7Y', retention_trigger_at: '2026-09-07T00:00:00.000Z',
    disposition_eligible_at: '2033-09-07T00:00:00.000Z', legal_hold: false,
    created_at: '2026-09-07T00:00:00.000Z', updated_at: '2026-09-07T01:00:00.000Z'
  }] }]);
  const repo = new PostgresRepository(db);
  await repo.assignRetention({
    caseId: 'case-1', retentionClassCode: 'CIVIL-7Y',
    retentionTriggerAt: '2026-09-07T00:00:00.000Z', dispositionEligibleAt: '2033-09-07T00:00:00.000Z',
    actorSubject: 'records-1', at: '2026-09-07T01:00:00.000Z'
  });
  const { text, params } = db.calls[0];
  assert.equal(params.length, 5, 'retention update must not bind an unused actor parameter');
  assert.match(text, /updated_at=\$5/i);
  assert.doesNotMatch(text, /\$6\b/);
});
