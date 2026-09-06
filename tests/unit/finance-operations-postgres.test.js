'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresRepository } = require('../../services/api/src/postgres-repository');

class FakeQueryable {
  constructor(rows = []) { this.rows = rows; this.calls = []; }
  async query(text, params = []) { this.calls.push({ text, params }); return { rows: this.rows }; }
}

const PAYMENT_ROW = {
  payment_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  assessment_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  court_id:'11111111-1111-1111-1111-111111111111',
  amount_minor:'12500',
  currency:'PGK',
  status:'PENDING',
  provider_reference:null,
  created_by_subject:'fin-a',
  created_at:'2026-09-06T06:00:00.000Z',
  confirmed_by_subject:null,
  confirmed_at:null
};

test('PostgresRepository finance queue is parameterized and constrained to supplied court scopes', async () => {
  const db = new FakeQueryable([PAYMENT_ROW]);
  const repo = new PostgresRepository(db);
  const rows = await repo.listFinanceQueue({
    courtIds:['11111111-1111-1111-1111-111111111111'],
    status:null
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paymentId, PAYMENT_ROW.payment_id);
  assert.equal(rows[0].amountMinor, 12500);
  assert.match(db.calls[0].text, /FROM finance\.payments/i);
  assert.match(db.calls[0].text, /court_id = ANY\(\$1::uuid\[\]\)/i);
  assert.deepEqual(db.calls[0].params, [['11111111-1111-1111-1111-111111111111']]);
});

test('PostgresRepository finance queue applies status as a bound parameter', async () => {
  const db = new FakeQueryable([{ ...PAYMENT_ROW, status:'CONFIRMED' }]);
  const repo = new PostgresRepository(db);
  const rows = await repo.listFinanceQueue({
    courtIds:['11111111-1111-1111-1111-111111111111'],
    status:'CONFIRMED'
  });
  assert.equal(rows[0].status, 'CONFIRMED');
  assert.match(db.calls[0].text, /status = \$2/i);
  assert.equal(db.calls[0].text.includes('CONFIRMED'), false);
  assert.deepEqual(db.calls[0].params, [['11111111-1111-1111-1111-111111111111'], 'CONFIRMED']);
});
