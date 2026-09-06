'use strict';
const { JudgmentPostgresRepository } = require('./judgment-postgres-repository');
const { mapReceipt, mapReconciliation } = require('./postgres-repository');

const PAYMENT_COLUMNS = `payment_id,assessment_id,court_id,amount_minor,currency,status,provider_reference,created_by_subject,created_at,confirmed_by_subject,confirmed_at`;
const RECEIPT_COLUMNS = `receipt_id,receipt_number,payment_id,court_id,amount_minor,currency,status,issued_by_subject,issued_at`;
const RECONCILIATION_COLUMNS = `reconciliation_id,payment_id,court_id,status,prepared_by_subject,prepared_at,certified_by_subject,certified_at`;
const PAYMENT_EXCEPTION_COLUMNS = `exception_id,payment_id,court_id,reason_code,evidence,status,created_by_subject,created_at,resolved_by_subject,resolved_at,resolution_note`;

function mapPayment(row) {
  if (!row) return null;
  return Object.freeze({
    paymentId: row.payment_id,
    assessmentId: row.assessment_id,
    courtId: row.court_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    providerReference: row.provider_reference || null,
    createdBy: row.created_by_subject,
    createdAt: row.created_at,
    confirmedBy: row.confirmed_by_subject || null,
    confirmedAt: row.confirmed_at || null
  });
}

function mapPaymentException(row) {
  if (!row) return null;
  return Object.freeze({
    exceptionId: row.exception_id,
    paymentId: row.payment_id,
    courtId: row.court_id,
    reasonCode: row.reason_code,
    evidence: row.evidence || {},
    status: row.status,
    createdBy: row.created_by_subject,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by_subject || null,
    resolvedAt: row.resolved_at || null,
    resolutionNote: row.resolution_note || null
  });
}

class FinanceOperationsPostgresRepository extends JudgmentPostgresRepository {
  async listFinanceQueue({ courtIds, status = null }) {
    const statusFilter = status ? ' AND status = $2' : '';
    const params = status ? [courtIds, status] : [courtIds];
    const result = await this.db.query(
      `SELECT ${PAYMENT_COLUMNS}
       FROM finance.payments
       WHERE court_id = ANY($1::uuid[])${statusFilter}
       ORDER BY created_at ASC, payment_id`,
      params
    );
    return result.rows.map(mapPayment);
  }

  async listReceipts({ courtIds, status = null }) {
    const statusFilter = status ? ' AND status = $2' : '';
    const params = status ? [courtIds, status] : [courtIds];
    const result = await this.db.query(
      `SELECT ${RECEIPT_COLUMNS}
       FROM finance.receipts
       WHERE court_id = ANY($1::uuid[])${statusFilter}
       ORDER BY issued_at DESC, receipt_id`,
      params
    );
    return result.rows.map(mapReceipt);
  }

  async listReconciliations({ courtIds, status = null }) {
    const statusFilter = status ? ' AND status = $2' : '';
    const params = status ? [courtIds, status] : [courtIds];
    const result = await this.db.query(
      `SELECT ${RECONCILIATION_COLUMNS}
       FROM finance.reconciliations
       WHERE court_id = ANY($1::uuid[])${statusFilter}
       ORDER BY prepared_at DESC, reconciliation_id`,
      params
    );
    return result.rows.map(mapReconciliation);
  }

  async getReconciliationByPayment(paymentId) {
    const result = await this.db.query(
      `SELECT ${RECONCILIATION_COLUMNS}
       FROM finance.reconciliations
       WHERE payment_id=$1
       ORDER BY prepared_at DESC, reconciliation_id
       LIMIT 1`,
      [paymentId]
    );
    return mapReconciliation(result.rows[0]);
  }

  async findPaymentByProviderReference(providerReference) {
    const result = await this.db.query(
      `SELECT ${PAYMENT_COLUMNS}
       FROM finance.payments
       WHERE provider_reference=$1
       LIMIT 1`,
      [providerReference]
    );
    return mapPayment(result.rows[0]);
  }

  async createPaymentException({ exceptionId, paymentId, courtId, reasonCode, evidence, createdBy, createdAt }) {
    const result = await this.db.query(
      `INSERT INTO finance.payment_exceptions
        (exception_id,payment_id,court_id,reason_code,evidence,status,created_by_subject,created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,'OPEN',$6,$7)
       RETURNING ${PAYMENT_EXCEPTION_COLUMNS}`,
      [exceptionId, paymentId, courtId, reasonCode, JSON.stringify(evidence || {}), createdBy, createdAt]
    );
    return mapPaymentException(result.rows[0]);
  }

  async listPaymentExceptions({ courtIds, status = null }) {
    const statusFilter = status ? ' AND status = $2' : '';
    const params = status ? [courtIds, status] : [courtIds];
    const result = await this.db.query(
      `SELECT ${PAYMENT_EXCEPTION_COLUMNS}
       FROM finance.payment_exceptions
       WHERE court_id = ANY($1::uuid[])${statusFilter}
       ORDER BY created_at DESC, exception_id`,
      params
    );
    return result.rows.map(mapPaymentException);
  }

  async getPaymentException(exceptionId) {
    const result = await this.db.query(
      `SELECT ${PAYMENT_EXCEPTION_COLUMNS}
       FROM finance.payment_exceptions
       WHERE exception_id=$1`,
      [exceptionId]
    );
    return mapPaymentException(result.rows[0]);
  }

  async resolvePaymentException({ exceptionId, actorSubject, at, resolutionNote }) {
    const result = await this.db.query(
      `UPDATE finance.payment_exceptions
       SET status='RESOLVED', resolved_by_subject=$2, resolved_at=$3, resolution_note=$4
       WHERE exception_id=$1 AND status='OPEN' AND created_by_subject <> $2
       RETURNING ${PAYMENT_EXCEPTION_COLUMNS}`,
      [exceptionId, actorSubject, at, resolutionNote]
    );
    if (result.rows.length !== 1) {
      const error = new Error('Payment exception was not resolvable');
      error.code = 'PAYMENT_EXCEPTION_STATE_CONFLICT';
      throw error;
    }
    return mapPaymentException(result.rows[0]);
  }
}

module.exports = { FinanceOperationsPostgresRepository, mapPayment, mapPaymentException };
