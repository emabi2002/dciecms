'use strict';
const { authorize } = require('../../../packages/rbac');
const { NotFoundError, ValidationError } = require('./dciecms-service');
const { JudicialWorkbenchService } = require('./judicial-workbench-service');

const PAYMENT_STATUSES = new Set(['PENDING','CONFIRMED','FAILED','CANCELLED','REFUNDED']);
const RECEIPT_STATUSES = new Set(['ISSUED','VOID']);
const RECONCILIATION_STATUSES = new Set(['PREPARED','CERTIFIED','REJECTED']);

function normalizeStatus(value, allowed, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const status = String(value).trim().toUpperCase();
  if (!allowed.has(status)) throw new ValidationError(`Invalid ${label} status`);
  return status;
}

class FinanceOperationsService extends JudicialWorkbenchService {
  async listFinanceQueue(actor, filters = {}) {
    authorize(actor, 'finance.payment.view', {});
    const status = normalizeStatus(filters?.status, PAYMENT_STATUSES, 'payment');
    const rows = await this.repository.listFinanceQueue({ courtIds: actor.courtIds, status });
    this._audit(actor, 'finance.queue.view', 'finance_queue', actor.courtIds.join(','), { courtIds: actor.courtIds, status });
    return rows;
  }

  async getPaymentDetail(actor, paymentId) {
    const payment = await this.repository.getPayment(paymentId);
    if (!payment) throw new NotFoundError('Payment not found');
    authorize(actor, 'finance.payment.view', { courtId: payment.courtId });
    const [assessment, receipt, reconciliation] = await Promise.all([
      this.repository.getFeeAssessment(payment.assessmentId),
      this.repository.getReceiptByPayment(payment.paymentId),
      this.repository.getReconciliationByPayment(payment.paymentId)
    ]);
    this._audit(actor, 'finance.payment.detail.view', 'payment', payment.paymentId, {
      courtId: payment.courtId,
      assessmentId: payment.assessmentId,
      receiptId: receipt?.receiptId || null,
      reconciliationId: reconciliation?.reconciliationId || null
    });
    return Object.freeze({ payment, assessment, receipt, reconciliation });
  }

  async listReceipts(actor, filters = {}) {
    authorize(actor, 'finance.receipt.view', {});
    const status = normalizeStatus(filters?.status, RECEIPT_STATUSES, 'receipt');
    const rows = await this.repository.listReceipts({ courtIds: actor.courtIds, status });
    this._audit(actor, 'finance.receipts.view', 'receipt_queue', actor.courtIds.join(','), { courtIds: actor.courtIds, status });
    return rows;
  }

  async listReconciliations(actor, filters = {}) {
    authorize(actor, 'finance.reconciliation.view', {});
    const status = normalizeStatus(filters?.status, RECONCILIATION_STATUSES, 'reconciliation');
    const rows = await this.repository.listReconciliations({ courtIds: actor.courtIds, status });
    this._audit(actor, 'finance.reconciliations.view', 'reconciliation_queue', actor.courtIds.join(','), { courtIds: actor.courtIds, status });
    return rows;
  }
}

module.exports = { FinanceOperationsService, normalizeStatus, PAYMENT_STATUSES, RECEIPT_STATUSES, RECONCILIATION_STATUSES };
