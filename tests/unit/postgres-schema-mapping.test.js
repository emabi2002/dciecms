'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMappedDatabase } = require('../../services/api/src/postgres-schema-mapping');

test('Supabase test profile rewrites logical schema-qualified tables to dciecms_test physical tables', async () => {
  const seen = [];
  const db = {
    async query(text, params) {
      seen.push({ text, params });
      return { rows: [] };
    }
  };
  const mapped = createMappedDatabase(db, 'supabase_test');
  await mapped.query(
    'SELECT * FROM case_mgmt.cases c JOIN judicial.judgments j ON j.case_id=c.case_id JOIN iam.users u ON true WHERE c.case_id=$1',
    ['case-1']
  );
  assert.match(seen[0].text, /dciecms_test\.cases c/);
  assert.match(seen[0].text, /dciecms_test\.judicial_judgments j/);
  assert.match(seen[0].text, /dciecms_test\.iam_users u/);
  assert.deepEqual(seen[0].params, ['case-1']);
});

test('mapping is applied to transactional clients returned by connect()', async () => {
  const seen = [];
  const client = {
    async query(text, params) { seen.push({ text, params }); return { rows: [] }; },
    release() { seen.push({ release: true }); }
  };
  const db = { async connect() { return client; } };
  const mapped = createMappedDatabase(db, 'supabase_test');
  const tx = await mapped.connect();
  await tx.query('UPDATE judicial.hearings SET status=$2 WHERE hearing_id=$1', ['h-1', 'IN_PROGRESS']);
  tx.release();
  assert.match(seen[0].text, /UPDATE dciecms_test\.judicial_hearings/);
  assert.equal(seen[1].release, true);
});

test('Supabase test profile maps durable idempotency and audit tables', async () => {
  const seen = [];
  const db = { async query(text) { seen.push(text); return { rows: [] }; } };
  const mapped = createMappedDatabase(db, 'supabase_test');
  await mapped.query('SELECT * FROM workflow.idempotency_records');
  await mapped.query('SELECT * FROM audit.audit_events');
  assert.match(seen[0], /FROM dciecms_test\.workflow_idempotency_records/);
  assert.match(seen[1], /FROM dciecms_test\.audit_events/);
});

test('logical profile leaves repository SQL unchanged', async () => {
  let sql;
  const db = { async query(text) { sql = text; return { rows: [] }; } };
  const mapped = createMappedDatabase(db, 'logical');
  await mapped.query('SELECT * FROM registry.filings');
  assert.equal(sql, 'SELECT * FROM registry.filings');
});
