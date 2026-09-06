'use strict';
const { authorize } = require('../../../packages/rbac');
const { NotFoundError } = require('./dciecms-service');
const { PersistentDciecmsService } = require('./persistent-dciecms-service');

class FinanceOperationsService extends PersistentDciecmsService {
  async listFinanceQueue(actor, filters = {}) {
    authorize(actor, 'finance.payment.view', {});
    const rows = await this.repository.listFinanceQueue({
      courtIds: actor.courtIds,
      status: filters?.status ? String(filters.status).trim().toUpperCase() : null
    });
    this._audit(actor, 'finance.queue.view', 'finance_queue', actor.courtIds.join(','), {
      courtIds: actor.courtIds,
      status: filters?.status ? String(filters.status).trim().toUpperCase() : null
    });
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
}

module.exports = { FinanceOperationsService };
