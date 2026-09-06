'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { FinanceOperationsService } = require('../../services/api/src/finance-operations-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const COURT_B = '22222222-2222-2222-2222-222222222222';
const fin = resolveActorFromClaims({ sub:'fin-a', roles:['FIN'], court_ids:[COURT_A] });
const finB = resolveActorFromClaims({ sub:'fin-b', roles:['FIN'], court_ids:[COURT_B] });
const finMgr = resolveActorFromClaims({ sub:'fin-mgr', roles:['FIN-MGR'], court_ids:[COURT_A, COURT_B] });
const legal = resolveActorFromClaims({ sub:'legal-a', roles:['LEGAL'], court_ids:[COURT_A] });

class FinanceOperationsRepo {
  constructor() {
    this.queueArgs = null;
    this.rows = [
      Object.freeze({ paymentId:'p-a', assessmentId:'a-a', courtId:COURT_A, status:'PENDING', amountMinor:12500, currency:'PGK' })
    ];
    this.payment = Object.freeze({ paymentId:'p-a', assessmentId:'a-a', courtId:COURT_A, status:'CONFIRMED', amountMinor:12500, currency:'PGK' });
    this.assessment = Object.freeze({ assessmentId:'a-a', filingId:'f-a', courtId:COURT_A, status:'PAID', amountMinor:12500, currency:'PGK' });
    this.receipt = Object.freeze({ receiptId:'r-a', paymentId:'p-a', courtId:COURT_A, status:'ISSUED', amountMinor:12500, currency:'PGK' });
    this.reconciliation = Object.freeze({ reconciliationId:'rec-a', paymentId:'p-a', courtId:COURT_A, status:'CERTIFIED' });
  }
  async listFinanceQueue(args) {
    this.queueArgs = args;
    return this.rows.filter(row => args.courtIds.includes(row.courtId));
  }
  async getPayment(id) { return id === this.payment.paymentId ? this.payment : null; }
  async getFeeAssessment(id) { return id === this.assessment.assessmentId ? this.assessment : null; }
  async getReceiptByPayment(id) { return id === this.receipt.paymentId ? this.receipt : null; }
  async getReconciliationByPayment(id) { return id === this.reconciliation.paymentId ? this.reconciliation : null; }
}

test('R3 exposes a dedicated finance operations service', () => {
  assert.equal(typeof FinanceOperationsService, 'function');
});

test('finance queue is constrained to the authenticated finance actor court scope', async () => {
  const repo = new FinanceOperationsRepo();
  const svc = new FinanceOperationsService({ repository: repo });
  const rows = await svc.listFinanceQueue(fin, {});
  assert.deepEqual(repo.queueArgs.courtIds, [COURT_A]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].courtId, COURT_A);
});

test('finance manager with multiple court scopes passes only those scopes to the queue repository', async () => {
  const repo = new FinanceOperationsRepo();
  repo.rows.push(Object.freeze({ paymentId:'p-b', courtId:COURT_B, status:'CONFIRMED', amountMinor:5000, currency:'PGK' }));
  const svc = new FinanceOperationsService({ repository: repo });
  const rows = await svc.listFinanceQueue(finMgr, {});
  assert.deepEqual(repo.queueArgs.courtIds, [COURT_A, COURT_B]);
  assert.equal(rows.length, 2);
});

test('non-finance role cannot read the finance queue', async () => {
  const repo = new FinanceOperationsRepo();
  const svc = new FinanceOperationsService({ repository: repo });
  await assert.rejects(() => svc.listFinanceQueue(legal, {}), /Permission denied: finance\.payment\.view/i);
  assert.equal(repo.queueArgs, null);
});

test('finance payment detail returns assessment receipt and reconciliation evidence', async () => {
  const svc = new FinanceOperationsService({ repository:new FinanceOperationsRepo() });
  const detail = await svc.getPaymentDetail(fin, 'p-a');
  assert.equal(detail.payment.paymentId, 'p-a');
  assert.equal(detail.assessment.assessmentId, 'a-a');
  assert.equal(detail.receipt.receiptId, 'r-a');
  assert.equal(detail.reconciliation.reconciliationId, 'rec-a');
});

test('cross-court finance actor cannot read payment detail by direct identifier', async () => {
  const svc = new FinanceOperationsService({ repository:new FinanceOperationsRepo() });
  await assert.rejects(() => svc.getPaymentDetail(finB, 'p-a'), /court scope|outside court/i);
});
