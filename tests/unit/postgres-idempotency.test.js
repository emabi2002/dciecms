'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresRepository } = require('../../services/api/src/postgres-repository');

function submittedFilingRow() {
  return {
    filing_id: 'f-1',
    filing_reference: 'F-1',
    court_id: 'c-1',
    case_type_code: 'CIVIL',
    filer_party_id: 'p-1',
    status: 'SUBMITTED',
    created_by: 'reg-a',
    created_at: '2026-09-06T00:00:00.000Z',
    submitted_at: '2026-09-06T00:10:00.000Z'
  };
}

function submittedFilingPayload() {
  return {
    filingId: 'f-1',
    filingReference: 'F-1',
    courtId: 'c-1',
    caseTypeCode: 'CIVIL',
    filerPartyId: 'p-1',
    status: 'SUBMITTED',
    createdBy: 'reg-a',
    createdAt: '2026-09-06T00:00:00.000Z',
    submittedAt: '2026-09-06T00:10:00.000Z',
    validatedAt: null,
    validatedBy: null,
    decisionReason: null,
    decisionBy: null,
    decisionAt: null
  };
}

test('PostgresRepository atomically claims filing submission idempotency and persists the canonical response', async () => {
  const calls = [];
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (/INSERT INTO workflow\.idempotency_records/i.test(text)) return { rows: [{ idempotency_record_id: 'idem-1' }] };
      if (/UPDATE registry\.filings/i.test(text)) return { rows: [submittedFilingRow()] };
      if (/INSERT INTO workflow\.workflow_tasks/i.test(text)) return { rows: [{ task_id: 't-1' }] };
      if (/UPDATE workflow\.idempotency_records/i.test(text)) return { rows: [{ idempotency_record_id: 'idem-1' }] };
      return { rows: [] };
    },
    release() { calls.push({ text: 'RELEASE', params: [] }); }
  };
  const repo = new PostgresRepository({ async connect() { return client; } });

  const filing = await repo.submitFilingIdempotent({
    filingId: 'f-1',
    taskId: 't-1',
    actorSubject: 'reg-a',
    submittedAt: '2026-09-06T00:10:00.000Z',
    idempotencyKey: 'req-123'
  });

  assert.equal(filing.status, 'SUBMITTED');
  assert.equal(calls[0].text, 'BEGIN');
  assert.match(calls[1].text, /ON CONFLICT[\s\S]*DO NOTHING/i);
  assert.deepEqual(calls[1].params, ['reg-a', 'f-1', 'req-123']);
  assert.equal(calls.filter(call => /UPDATE registry\.filings/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO workflow\.workflow_tasks/i.test(call.text)).length, 1);
  const responseWrite = calls.find(call => /UPDATE workflow\.idempotency_records/i.test(call.text));
  assert.ok(responseWrite);
  assert.equal(responseWrite.params[1], 'idem-1');
  assert.deepEqual(JSON.parse(responseWrite.params[0]), filing);
  assert.equal(calls.at(-2).text, 'COMMIT');
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('PostgresRepository replays a durable filing submission response without repeating business mutations', async () => {
  const calls = [];
  const stored = submittedFilingPayload();
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (/INSERT INTO workflow\.idempotency_records/i.test(text)) return { rows: [] };
      if (/SELECT response_payload/i.test(text)) return { rows: [{ response_payload: stored }] };
      return { rows: [] };
    },
    release() { calls.push({ text: 'RELEASE', params: [] }); }
  };
  const repo = new PostgresRepository({ async connect() { return client; } });

  const filing = await repo.submitFilingIdempotent({
    filingId: 'f-1',
    taskId: 'unused',
    actorSubject: 'reg-a',
    submittedAt: '2026-09-06T00:11:00.000Z',
    idempotencyKey: 'req-123'
  });

  assert.deepEqual(filing, stored);
  assert.equal(calls.filter(call => /UPDATE registry\.filings/i.test(call.text)).length, 0);
  assert.equal(calls.filter(call => /INSERT INTO workflow\.workflow_tasks/i.test(call.text)).length, 0);
  assert.equal(calls.filter(call => /UPDATE workflow\.idempotency_records/i.test(call.text)).length, 0);
  assert.equal(calls.at(-2).text, 'COMMIT');
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('PostgresRepository rolls back the idempotency claim when filing submission cannot transition', async () => {
  const calls = [];
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (/INSERT INTO workflow\.idempotency_records/i.test(text)) return { rows: [{ idempotency_record_id: 'idem-1' }] };
      if (/UPDATE registry\.filings/i.test(text)) return { rows: [] };
      return { rows: [] };
    },
    release() { calls.push({ text: 'RELEASE', params: [] }); }
  };
  const repo = new PostgresRepository({ async connect() { return client; } });

  await assert.rejects(
    () => repo.submitFilingIdempotent({
      filingId: 'f-1',
      taskId: 't-1',
      actorSubject: 'reg-a',
      submittedAt: '2026-09-06T00:10:00.000Z',
      idempotencyKey: 'req-123'
    }),
    error => error && error.code === 'FILING_STATE_CONFLICT'
  );

  assert.equal(calls.filter(call => /INSERT INTO workflow\.workflow_tasks/i.test(call.text)).length, 0);
  assert.equal(calls.filter(call => /UPDATE workflow\.idempotency_records/i.test(call.text)).length, 0);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-2).text, 'ROLLBACK');
  assert.equal(calls.at(-1).text, 'RELEASE');
});
