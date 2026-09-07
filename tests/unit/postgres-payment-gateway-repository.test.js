'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresRepository } = require('../../services/api/src/postgres-repository');

const PAYMENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ASSESSMENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const COURT_ID = '11111111-1111-1111-1111-111111111111';

class FakeQueryable {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }
  async query(text, params = []) {
    this.calls.push({ text, params });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return next || { rows:[] };
  }
}

function paymentRow(overrides = {}) {
  return {
    payment_id:PAYMENT_ID,
    assessment_id:ASSESSMENT_ID,
    court_id:COURT_ID,
    amount_minor:'12500',
    currency:'PGK',
    status:'PENDING',
    provider_reference:null,
    created_by_subject:'fin-a',
    created_at:'2026-09-07T02:00:00.000Z',
    confirmed_by_subject:null,
    confirmed_at:null,
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    paymentReference:PAYMENT_ID,
    providerPaymentReference:'gw-pay-1',
    amountMinor:12500,
    currency:'PGK',
    actorSubject:'system:payment-gateway',
    confirmedAt:'2026-09-07T03:15:00.000Z',
    ...overrides
  };
}

test('verified gateway confirmation locks the authoritative DCIECMS payment by payment_id', async () => {
  const confirmed = paymentRow({
    status:'CONFIRMED',
    provider_reference:'gw-pay-1',
    confirmed_by_subject:'system:payment-gateway',
    confirmed_at:'2026-09-07T03:15:00.000Z'
  });
  const db = new FakeQueryable([{ rows:[paymentRow()] }, { rows:[confirmed] }]);
  const repo = new PostgresRepository(db);

  const result = await repo.confirmPaymentFromVerifiedGateway(input());

  assert.equal(result.paymentId, PAYMENT_ID);
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.providerReference, 'gw-pay-1');
  assert.equal(result.amountMinor, 12500);
  assert.match(db.calls[0].text, /FROM finance\.payments/i);
  assert.match(db.calls[0].text, /payment_id=\$1/i);
  assert.match(db.calls[0].text, /FOR UPDATE/i);
  assert.deepEqual(db.calls[0].params, [PAYMENT_ID]);
});

test('verified gateway confirmation updates only PENDING payment using canonical provider evidence', async () => {
  const confirmed = paymentRow({
    status:'CONFIRMED',
    provider_reference:'gw-pay-1',
    confirmed_by_subject:'system:payment-gateway',
    confirmed_at:'2026-09-07T03:15:00.000Z'
  });
  const db = new FakeQueryable([{ rows:[paymentRow()] }, { rows:[confirmed] }]);
  const repo = new PostgresRepository(db);

  await repo.confirmPaymentFromVerifiedGateway(input());

  assert.match(db.calls[1].text, /UPDATE finance\.payments/i);
  assert.match(db.calls[1].text, /status='CONFIRMED'/i);
  assert.match(db.calls[1].text, /provider_reference/i);
  assert.match(db.calls[1].text, /confirmed_by_subject/i);
  assert.match(db.calls[1].text, /WHERE\s+payment_id=\$1\s+AND\s+status='PENDING'/i);
  assert.equal(db.calls[1].params.includes('gw-pay-1'), true);
  assert.equal(db.calls[1].params.includes('system:payment-gateway'), true);
  assert.doesNotMatch(db.calls[1].text, /INSERT INTO finance\.receipts/i);
});

test('verified gateway confirmation rejects amount mismatch before payment update', async () => {
  const db = new FakeQueryable([{ rows:[paymentRow()] }]);
  const repo = new PostgresRepository(db);

  await assert.rejects(
    () => repo.confirmPaymentFromVerifiedGateway(input({ amountMinor:12499 })),
    error => error && error.code === 'PAYMENT_GATEWAY_AMOUNT_MISMATCH'
  );
  assert.equal(db.calls.length, 1);
});

test('verified gateway confirmation rejects currency mismatch before payment update', async () => {
  const db = new FakeQueryable([{ rows:[paymentRow()] }]);
  const repo = new PostgresRepository(db);

  await assert.rejects(
    () => repo.confirmPaymentFromVerifiedGateway(input({ currency:'USD' })),
    error => error && error.code === 'PAYMENT_GATEWAY_CURRENCY_MISMATCH'
  );
  assert.equal(db.calls.length, 1);
});

test('verified gateway confirmation rejects conflicting existing provider reference', async () => {
  const db = new FakeQueryable([{ rows:[paymentRow({ provider_reference:'other-gateway-ref' })] }]);
  const repo = new PostgresRepository(db);

  await assert.rejects(
    () => repo.confirmPaymentFromVerifiedGateway(input()),
    error => error && error.code === 'PAYMENT_GATEWAY_REFERENCE_MISMATCH'
  );
  assert.equal(db.calls.length, 1);
});

test('verified gateway confirmation rejects an already-confirmed payment as a fresh callback mutation', async () => {
  const db = new FakeQueryable([{ rows:[paymentRow({
    status:'CONFIRMED',
    provider_reference:'gw-pay-1',
    confirmed_by_subject:'system:payment-gateway',
    confirmed_at:'2026-09-07T03:00:00.000Z'
  })] }]);
  const repo = new PostgresRepository(db);

  await assert.rejects(
    () => repo.confirmPaymentFromVerifiedGateway(input()),
    error => error && error.code === 'PAYMENT_GATEWAY_STATE_CONFLICT'
  );
  assert.equal(db.calls.length, 1);
});

test('verified gateway confirmation rejects unknown payment reference', async () => {
  const db = new FakeQueryable([{ rows:[] }]);
  const repo = new PostgresRepository(db);

  await assert.rejects(
    () => repo.confirmPaymentFromVerifiedGateway(input()),
    error => error && error.code === 'PAYMENT_NOT_FOUND'
  );
});

test('verified gateway repository path cannot issue receipts or open cases directly', () => {
  const repo = new PostgresRepository(new FakeQueryable());
  assert.equal(typeof repo.confirmPaymentFromVerifiedGateway, 'function');
  assert.notEqual(repo.confirmPaymentFromVerifiedGateway, repo.issueReceipt);
  assert.notEqual(repo.confirmPaymentFromVerifiedGateway, repo.openCase);
});
