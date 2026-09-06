'use strict';
const { authorize } = require('../../../packages/rbac');
const { NotFoundError } = require('./dciecms-service');
const { JudicialWorkbenchService } = require('./judicial-workbench-service');

class FinanceOperationsService extends JudicialWorkbenchService {
  async listFinanceQueue(actor, filters = {}) {
    authorize(actor, 'finance.payment.view', {});
    const status = filters?.status ? String(filters.status).trim().toUpperCase() : null;
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
    const status = filters?.status ? String(filters.status).trim().toUpperCase() : null;
    const rows = await this.repository.listReceipts({ courtIds: actor.courtIds, status });
    this._audit(actor, 'finance.receipts.view', 'receipt_queue', actor.courtIds.join(','), { courtIds: actor.courtIds, status });
    return rows;
  }

  async listReconciliations(actor, filters = {}) {
    authorize(actor, 'finance.reconciliation.view', {});
    const status = filters?.status ? String(filters.status).trim().toUpperCase() : null;
    const rows = await this.repository.listReconciliations({ courtIds: actor.courtIds, status });
    this._audit(actor, 'finance.reconciliations.view', 'reconciliation_queue', actor.courtIds.join(','), { courtIds: actor.courtIds, status });
    return rows;
  }
}

module.exports = { FinanceOperationsService };
