'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresTransactionManager } = require('../../services/api/src/postgres-transaction-manager');

function fakePool() {
  const calls = [];
  const client = {
    async query(text, params = []) {
      calls.push({ target: 'client', text, params });
      return { rows: [] };
    },
    release() { calls.push({ target: 'client', text: 'RELEASE', params: [] }); }
  };
  return {
    calls,
    client,
    pool: {
      async query(text, params = []) {
        calls.push({ target: 'pool', text, params });
        return { rows: [] };
      },
      async connect() {
        calls.push({ target: 'pool', text: 'CONNECT', params: [] });
        return client;
      }
    }
  };
}

test('PostgresTransactionManager commits one outer transaction and routes queries to its client', async () => {
  const fixture = fakePool();
  const db = new PostgresTransactionManager(fixture.pool);

  await db.withTransaction(async () => {
    await db.query('UPDATE registry.filings SET status=$1', ['SUBMITTED']);
    await db.query('INSERT INTO audit.audit_events(action) VALUES ($1)', ['filing.submit']);
  });

  assert.deepEqual(fixture.calls.map(call => call.text), [
    'CONNECT',
    'BEGIN',
    'UPDATE registry.filings SET status=$1',
    'INSERT INTO audit.audit_events(action) VALUES ($1)',
    'COMMIT',
    'RELEASE'
  ]);
  assert.equal(fixture.calls.filter(call => call.target === 'pool' && /UPDATE|INSERT/.test(call.text)).length, 0);
});

test('PostgresTransactionManager rolls back the business mutation when later work fails', async () => {
  const fixture = fakePool();
  const db = new PostgresTransactionManager(fixture.pool);

  await assert.rejects(
    () => db.withTransaction(async () => {
      await db.query('UPDATE finance.payments SET status=$1', ['CONFIRMED']);
      throw new Error('audit insert failed');
    }),
    /audit insert failed/
  );

  assert.equal(fixture.calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(fixture.calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(fixture.calls.at(-1).text, 'RELEASE');
});

test('nested repository transaction controls cannot commit or release the outer transaction', async () => {
  const fixture = fakePool();
  const db = new PostgresTransactionManager(fixture.pool);

  await db.withTransaction(async () => {
    const nested = await db.connect();
    await nested.query('BEGIN');
    await nested.query('UPDATE case_mgmt.cases SET status=$1', ['ASSIGNED']);
    await nested.query('COMMIT');
    nested.release();
    await db.query('INSERT INTO audit.audit_events(action) VALUES ($1)', ['case.assign']);
  });

  assert.equal(fixture.calls.filter(call => call.text === 'BEGIN').length, 1);
  assert.equal(fixture.calls.filter(call => call.text === 'COMMIT').length, 1);
  assert.equal(fixture.calls.filter(call => call.text === 'RELEASE').length, 1);
  assert.ok(fixture.calls.find(call => call.text.startsWith('UPDATE case_mgmt.cases')));
  assert.ok(fixture.calls.find(call => call.text.startsWith('INSERT INTO audit.audit_events')));
});
