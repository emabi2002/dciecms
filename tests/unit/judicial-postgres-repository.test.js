'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JudicialPostgresRepository } = require('../../services/api/src/judicial-postgres-repository');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const CASE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function caseRow(overrides = {}) {
  return {
    case_id: CASE_A,
    case_number: 'POM-CIVIL-2026-000001',
    filing_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    payment_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    court_id: COURT_A,
    case_type_code: 'CIVIL',
    status: 'OPEN',
    opened_by_subject: 'reg-mgr-a',
    opened_at: '2026-09-06T00:00:00.000Z',
    assigned_to_subject: null,
    assigned_by_subject: null,
    assigned_at: null,
    ...overrides
  };
}

test('judicial repository resolves an active MAG assignment in the requested court', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ eligible: true }] }; } };
  const repo = new JudicialPostgresRepository(db);
  const eligible = await repo.isActiveMagistrateInCourt('mag-a', COURT_A);
  assert.equal(eligible, true);
  assert.match(calls[0].sql, /iam\.user_role_assignments/i);
  assert.match(calls[0].sql, /role_code\s*=\s*'MAG'/i);
  assert.deepEqual(calls[0].params, ['mag-a', COURT_A]);
});

test('judicial repository assigns only an unassigned OPEN or AWAITING_ASSIGNMENT case', async () => {
  const calls = [];
  const db = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [caseRow({ status: 'ASSIGNED', assigned_to_subject: 'mag-a', assigned_by_subject: 'cmag-a', assigned_at: params[3] })] };
  } };
  const repo = new JudicialPostgresRepository(db);
  const assigned = await repo.assignCase({ caseId: CASE_A, assigneeSubject: 'mag-a', actorSubject: 'cmag-a', assignedAt: '2026-09-06T00:10:00.000Z' });
  assert.equal(assigned.status, 'ASSIGNED');
  assert.equal(assigned.assignedToSubject, 'mag-a');
  assert.match(calls[0].sql, /assigned_to_subject\s+IS\s+NULL/i);
  assert.match(calls[0].sql, /status\s*=\s*ANY/i);
});

test('judicial repository reports a conflict when assignment update affects no row', async () => {
  const db = { query: async () => ({ rows: [] }) };
  const repo = new JudicialPostgresRepository(db);
  await assert.rejects(
    () => repo.assignCase({ caseId: CASE_A, assigneeSubject: 'mag-a', actorSubject: 'cmag-a', assignedAt: '2026-09-06T00:10:00.000Z' }),
    error => error.code === 'CASE_ASSIGNMENT_CONFLICT'
  );
});

test('judicial repository lists only cases assigned to the subject within supplied court scope', async () => {
  const calls = [];
  const db = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [caseRow({ status: 'ASSIGNED', assigned_to_subject: 'mag-a' })] };
  } };
  const repo = new JudicialPostgresRepository(db);
  const rows = await repo.listAssignedCases({ courtIds: [COURT_A], assigneeSubject: 'mag-a' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assignedToSubject, 'mag-a');
  assert.match(calls[0].sql, /court_id\s*=\s*ANY/i);
  assert.match(calls[0].sql, /assigned_to_subject\s*=\s*\$2/i);
  assert.deepEqual(calls[0].params, [[COURT_A], 'mag-a']);
});