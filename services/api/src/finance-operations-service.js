'use strict';
const { randomUUID } = require('node:crypto');
const { authorize } = require('../../../packages/rbac');
const { NotFoundError, ValidationError, ConflictError } = require('./dciecms-service');
const { JudicialWorkbenchService } = require('./judicial-workbench-service');

const PAYMENT_STATUSES = new Set(['PENDING','CONFIRMED','FAILED','CANCELLED','REFUNDED']);
const RECEIPT_STATUSES = new Set(['ISSUED','VOID']);
const RECONCILIATION_STATUSES = new Set(['PREPARED','CERTIFIED','REJECTED']);
const EXCEPTION_STATUSES = new Set(['OPEN','RESOLVED']);

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

  async inspectPaymentObservation(actor, paymentId, observation = {}) {
    const payment = await this.repository.getPayment(paymentId);
    if (!payment) throw new NotFoundError('Payment not found');
    authorize(actor, 'finance.payment.view', { courtId: payment.courtId });

    const providerReference = observation.providerReference ? String(observation.providerReference).trim() : null;
    const observedCurrency = observation.currency ? String(observation.currency).trim().toUpperCase() : null;
    const observedAmountMinor = observation.amountMinor;
    const at = new Date().toISOString();
    const reasons = [];

    if (providerReference && typeof this.repository.findPaymentByProviderReference === 'function') {
      const conflicting = await this.repository.findPaymentByProviderReference(providerReference);
      if (conflicting && conflicting.paymentId !== payment.paymentId) {
        reasons.push({
          reasonCode: 'DUPLICATE_PROVIDER_REFERENCE',
          evidence: { providerReference, conflictingPaymentId: conflicting.paymentId, ...(observation.evidence || {}) }
        });
      }
    }
    if (observedAmountMinor !== undefined && Number(observedAmountMinor) !== Number(payment.amountMinor)) {
      reasons.push({
        reasonCode: 'AMOUNT_MISMATCH',
        evidence: { expectedAmountMinor: Number(payment.amountMinor), observedAmountMinor: Number(observedAmountMinor), ...(observation.evidence || {}) }
      });
    }
    if (observedCurrency && observedCurrency !== String(payment.currency).toUpperCase()) {
      reasons.push({
        reasonCode: 'CURRENCY_MISMATCH',
        evidence: { expectedCurrency: payment.currency, observedCurrency, ...(observation.evidence || {}) }
      });
    }

    const created = [];
    for (const reason of reasons) {
      created.push(await this.repository.createPaymentException({
        exceptionId: randomUUID(),
        paymentId: payment.paymentId,
        courtId: payment.courtId,
        reasonCode: reason.reasonCode,
        evidence: reason.evidence,
        createdBy: actor.userId,
        createdAt: at
      }));
    }
    this._audit(actor, 'finance.payment.inspect', 'payment', payment.paymentId, { courtId: payment.courtId, exceptionCount: created.length, reasonCodes: created.map(x => x.reasonCode) });
    return created;
  }

  async listPaymentExceptions(actor, filters = {}) {
    authorize(actor, 'finance.payment.view', {});
    const status = normalizeStatus(filters?.status || 'OPEN', EXCEPTION_STATUSES, 'payment exception');
    const rows = await this.repository.listPaymentExceptions({ courtIds: actor.courtIds, status });
    this._audit(actor, 'finance.payment_exceptions.view', 'payment_exception_queue', actor.courtIds.join(','), { courtIds: actor.courtIds, status });
    return rows;
  }

  async resolvePaymentException(actor, exceptionId, input = {}) {
    authorize(actor, 'finance.reconciliation.certify', {});
    const exception = await this.repository.getPaymentException(exceptionId);
    if (!exception) throw new NotFoundError('Payment exception not found');
    authorize(actor, 'finance.reconciliation.certify', { courtId: exception.courtId });
    if (exception.createdBy === actor.userId) throw new ConflictError('Same actor cannot create and resolve a payment exception');
    const resolutionNote = String(input.resolutionNote || '').trim();
    if (!resolutionNote) throw new ValidationError('Resolution note is required');
    const row = await this.repository.resolvePaymentException({
      exceptionId,
      actorSubject: actor.userId,
      at: new Date().toISOString(),
      resolutionNote
    });
    this._audit(actor, 'finance.payment_exception.resolve', 'payment_exception', exceptionId, { courtId: exception.courtId, paymentId: exception.paymentId });
    return row;
  }
}

module.exports = { FinanceOperationsService, normalizeStatus, PAYMENT_STATUSES, RECEIPT_STATUSES, RECONCILIATION_STATUSES, EXCEPTION_STATUSES };
