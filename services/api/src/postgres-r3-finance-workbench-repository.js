'use strict';

const PAYMENT_COLUMNS = `payment_id,assessment_id,court_id,amount_minor,currency,status,refunded_amount_minor,
  created_by_subject,created_at,confirmed_by_subject,confirmed_at`;
const REFUND_COLUMNS = `refund_request_id,payment_id,court_id,amount_minor,currency,reason,status,
  requested_by_subject,requested_at,decided_by_subject,decided_at,decision_reason,
  provider_refund_reference,completed_by_subject,completed_at`;
const ASSESSMENT_COLUMNS = `assessment_id,filing_id,court_id,fee_schedule_id,amount_minor,currency,status,
  assessed_by_subject,assessed_at`;

function iso(value) { return value instanceof Date ? value.toISOString() : value; }

function mapPayment(row) {
  if (!row) return null;
  return Object.freeze({
    paymentId:row.payment_id, assessmentId:row.assessment_id, courtId:row.court_id,
    amountMinor:Number(row.amount_minor), currency:row.currency, status:row.status,
    refundedAmountMinor:Number(row.refunded_amount_minor || 0),
    createdBy:row.created_by_subject, createdAt:iso(row.created_at),
    confirmedBy:row.confirmed_by_subject || null, confirmedAt:iso(row.confirmed_at) || null
  });
}

function mapRefund(row) {
  if (!row) return null;
  return Object.freeze({
    refundRequestId:row.refund_request_id, paymentId:row.payment_id, courtId:row.court_id,
    amountMinor:Number(row.amount_minor), currency:row.currency, reason:row.reason, status:row.status,
    requestedBy:row.requested_by_subject, requestedAt:iso(row.requested_at),
    decidedBy:row.decided_by_subject || null, decidedAt:iso(row.decided_at) || null,
    decisionReason:row.decision_reason || null, providerRefundReference:row.provider_refund_reference || null,
    completedBy:row.completed_by_subject || null, completedAt:iso(row.completed_at) || null
  });
}

function mapAssessment(row) {
  if (!row) return null;
  return Object.freeze({
    assessmentId:row.assessment_id, filingId:row.filing_id, courtId:row.court_id,
    feeScheduleId:row.fee_schedule_id || null, amountMinor:Number(row.amount_minor),
    currency:row.currency, status:row.status, assessedBy:row.assessed_by_subject,
    assessedAt:iso(row.assessed_at)
  });
}

function installR3FinanceWorkbenchRepository(PostgresRepository) {
  if (!PostgresRepository?.prototype) throw new TypeError('PostgresRepository constructor is required');
  const proto = PostgresRepository.prototype;
  if (proto.__r3FinanceWorkbenchRepositoryInstalled) return;
  Object.defineProperty(proto,'__r3FinanceWorkbenchRepositoryInstalled',{value:true,enumerable:false,writable:false,configurable:false});

  proto.listFinancePayments = async function listFinancePayments({ courtIds, status = null } = {}) {
    const result = await this.db.query(`SELECT ${PAYMENT_COLUMNS} FROM finance.payments
      WHERE court_id=ANY($1::uuid[]) AND ($2::varchar IS NULL OR status=$2)
      ORDER BY created_at DESC,payment_id`, [courtIds || [], status]);
    return result.rows.map(mapPayment);
  };

  proto.listRefundRequests = async function listRefundRequests({ courtIds, status = null } = {}) {
    const result = await this.db.query(`SELECT ${REFUND_COLUMNS} FROM finance.refund_requests
      WHERE court_id=ANY($1::uuid[]) AND ($2::varchar IS NULL OR status=$2)
      ORDER BY requested_at DESC,refund_request_id`, [courtIds || [], status]);
    return result.rows.map(mapRefund);
  };

  proto.createFeeAssessment = async function createFeeAssessment({ assessmentId, filingId, courtId, feeScheduleId = null, amountMinor, currency, actorSubject, at }) {
    const result = await this.db.query(`INSERT INTO finance.fee_assessments
      (assessment_id,filing_id,court_id,fee_schedule_id,amount_minor,currency,status,assessed_by_subject,assessed_at)
      VALUES ($1,$2,$3,$4,$5,$6,'ASSESSED',$7,$8)
      RETURNING ${ASSESSMENT_COLUMNS}`,
      [assessmentId,filingId,courtId,feeScheduleId,amountMinor,currency,actorSubject,at]);
    return mapAssessment(result.rows[0]);
  };

  proto.getFeeAssessment = async function getFeeAssessment(assessmentId) {
    const result = await this.db.query(`SELECT ${ASSESSMENT_COLUMNS} FROM finance.fee_assessments WHERE assessment_id=$1`, [assessmentId]);
    return mapAssessment(result.rows[0]);
  };
}

module.exports = { installR3FinanceWorkbenchRepository };
