'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PostgresRepository } = require('../../services/api/src/postgres-repository');
const { hasPermission } = require('../../packages/rbac');

class FakeQueryable {
  constructor(rows = []) {
    this.rows = rows;
    this.calls = [];
  }

  async query(text, params = []) {
    this.calls.push({ text, params });
    return { rows: this.rows };
  }
}

function actor(role) {
  return { userId: `${role.toLowerCase()}-1`, roles: [role], courtIds: ['COURT-A'], explicitGrants: [] };
}

const requestedRow = {
  disposal_request_id: 'dr-1',
  case_record_control_id: 'rc-1',
  case_id: 'case-1',
  court_id: 'COURT-A',
  status: 'REQUESTED',
  reason: 'Retention expired',
  requested_by_subject: 'records-1',
  requested_at: '2033-09-07T00:00:00.000Z',
  decided_by_subject: null,
  decided_at: null,
  decision_reason: null
};

const approvedRow = {
  ...requestedRow,
  status: 'APPROVED',
  decided_by_subject: 'cmag-1',
  decided_at: '2033-09-07T00:01:00.000Z',
  decision_reason: 'Approved after review'
};

function assertAtomicDocumentHoldVeto(sql) {
  assert.match(sql, /NOT\s+EXISTS\s*\(/i, 'disposal SQL must contain an atomic NOT EXISTS legal-hold veto');
  assert.match(sql, /documents\.documents/i, 'disposal SQL must re-check authoritative document state');
  assert.match(sql, /legal_hold\s*=\s*true/i, 'disposal SQL must veto document legal holds');
  assert.match(sql, /filing_id/i, 'document hold check must be scoped through the case filing');
}

test('disposal request atomically re-checks document legal holds inside the persistence mutation', async () => {
  const db = new FakeQueryable([requestedRow]);
  const repo = new PostgresRepository(db);
  await repo.createDisposalRequest({
    disposalRequestId: 'dr-1',
    caseId: 'case-1',
    reason: 'Retention expired',
    actorSubject: 'records-1',
    at: '2033-09-07T00:00:00.000Z'
  });
  assertAtomicDocumentHoldVeto(db.calls[0].text);
});

test('disposal approval atomically re-checks document legal holds inside the decision mutation', async () => {
  const db = new FakeQueryable([approvedRow]);
  const repo = new PostgresRepository(db);
  await repo.approveDisposalRequest({
    disposalRequestId: 'dr-1',
    actorSubject: 'cmag-1',
    decisionReason: 'Approved after review',
    at: '2033-09-07T00:01:00.000Z'
  });
  assertAtomicDocumentHoldVeto(db.calls[0].text);
});

test('RECORDS role cannot acquire judicial or disposal-approval authority', () => {
  const records = actor('RECORDS');
  for (const permission of ['case.disposition', 'case.close', 'case.reopen', 'judgment.issue', 'hearing.schedule', 'records.disposal.approve']) {
    assert.equal(hasPermission(records, permission), false, `RECORDS must not have ${permission}`);
  }
});

test('case lifecycle records implementation exposes no physical deletion or disposal-execution code path', () => {
  const httpSource = fs.readFileSync(path.join(__dirname, '../../services/api/src/http-app.js'), 'utf8');
  const repoSource = fs.readFileSync(path.join(__dirname, '../../services/api/src/postgres-case-lifecycle-records-repository.js'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/0015_case_lifecycle_records.sql'), 'utf8');

  assert.doesNotMatch(httpSource, /disposal-requests\/[^\n]*\/execute/i);
  assert.doesNotMatch(repoSource, /DELETE\s+FROM/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
  assert.match(migration, /REVOKE DELETE ON case_mgmt\.case_lifecycle_events FROM PUBLIC/i);
  assert.match(migration, /REVOKE DELETE ON records\.case_record_controls FROM PUBLIC/i);
  assert.match(migration, /REVOKE DELETE ON records\.disposal_requests FROM PUBLIC/i);
});
