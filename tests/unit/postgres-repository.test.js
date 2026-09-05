'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { PostgresRepository } = require('../../services/api/src/postgres-repository');

class FakeQueryable {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }
  async query(text, params = []) {
    this.calls.push({ text, params });
    return this.responses.shift() || { rows: [] };
  }
}

test('PostgresRepository createParty uses parameterized SQL and maps returned row', async () => {
  const db = new FakeQueryable([{ rows: [{ party_id:'p-1', court_id:'c-1', party_type:'PERSON', display_name:'Jane Doe', created_at:'2026-09-05T00:00:00.000Z' }] }]);
  const repo = new PostgresRepository(db);
  const party = await repo.createParty({ partyId:'p-1', courtId:'c-1', partyType:'PERSON', displayName:'Jane Doe' });
  assert.equal(party.partyId, 'p-1');
  assert.equal(party.displayName, 'Jane Doe');
  assert.match(db.calls[0].text, /INSERT INTO case_mgmt\.parties/i);
  assert.equal(db.calls[0].params.includes('Jane Doe'), true);
  assert.equal(db.calls[0].text.includes('Jane Doe'), false);
});

test('PostgresRepository creates registry validation task with a parameterized filing reference', async () => {
  const db = new FakeQueryable([{ rows: [{ task_id:'t-1', filing_id:'f-1', court_id:'c-1', task_type:'REGISTRY_VALIDATE_FILING', assigned_role_code:'REG', status:'PENDING', created_at:'2026-09-05T00:00:00.000Z' }] }]);
  const repo = new PostgresRepository(db);
  const task = await repo.createRegistryValidationTask({ taskId:'t-1', filingId:'f-1', courtId:'c-1' });
  assert.equal(task.taskType, 'REGISTRY_VALIDATE_FILING');
  assert.match(db.calls[0].text, /INSERT INTO workflow\.workflow_tasks/i);
  assert.deepEqual(db.calls[0].params.slice(0,3), ['t-1','f-1','c-1']);
});

test('PostgresRepository lists workflow tasks only for supplied court scopes', async () => {
  const db = new FakeQueryable([{ rows: [{ task_id:'t-1', filing_id:'f-1', court_id:'c-1', task_type:'REGISTRY_VALIDATE_FILING', assigned_role_code:'REG', status:'PENDING', created_at:'2026-09-05T00:00:00.000Z' }] }]);
  const repo = new PostgresRepository(db);
  const rows = await repo.listWorkflowTasks({ courtIds:['c-1','c-2'], includeCompleted:false });
  assert.equal(rows.length, 1);
  assert.match(db.calls[0].text, /court_id = ANY\(\$1::uuid\[\]\)/i);
  assert.deepEqual(db.calls[0].params, [['c-1','c-2']]);
  assert.match(db.calls[0].text, /status <> 'COMPLETED'/i);
});

test('PostgresRepository validates filing and completes task inside one transaction', async () => {
  const calls = [];
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (/UPDATE registry\.filings/i.test(text)) return { rows:[{ filing_id:'f-1', filing_reference:'F-1', court_id:'c-1', case_type_code:'CIVIL', filer_party_id:'p-1', status:'VALIDATED', created_by:'reg-a', created_at:'2026-09-05T00:00:00.000Z', submitted_at:'2026-09-05T00:10:00.000Z', validated_at:'2026-09-05T00:20:00.000Z', validated_by_subject:'reg-a' }] };
      if (/UPDATE workflow\.workflow_tasks/i.test(text)) return { rows:[{ task_id:'t-1' }] };
      return { rows:[] };
    },
    release() { calls.push({ text:'RELEASE', params:[] }); }
  };
  const pool = { async connect(){ return client; } };
  const repo = new PostgresRepository(pool);
  const filing = await repo.validateFilingAndCompleteTask({ filingId:'f-1', taskId:'t-1', actorSubject:'reg-a', validatedAt:'2026-09-05T00:20:00.000Z' });
  assert.equal(filing.status, 'VALIDATED');
  assert.equal(calls[0].text, 'BEGIN');
  assert.equal(calls.at(-2).text, 'COMMIT');
  assert.equal(calls.at(-1).text, 'RELEASE');
});
