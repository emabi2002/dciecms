'use strict';
const { JudgmentPostgresRepository } = require('./judgment-postgres-repository');
const { mapReconciliation } = require('./postgres-repository');

const PAYMENT_COLUMNS = `payment_id,assessment_id,court_id,amount_minor,currency,status,provider_reference,created_by_subject,created_at,confirmed_by_subject,confirmed_at`;
const RECONCILIATION_COLUMNS = `reconciliation_id,payment_id,court_id,status,prepared_by_subject,prepared_at,certified_by_subject,certified_at`;

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
}

module.exports = { FinanceOperationsPostgresRepository, mapPayment };
