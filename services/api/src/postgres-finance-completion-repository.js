'use strict';

const SCHEDULE_COLUMNS = `fee_schedule_id,court_id,case_type_code,fee_code,description,amount_minor,currency,
  effective_from,effective_to,status,created_by_subject,created_at,activated_by_subject,activated_at,
  retired_by_subject,retired_at`;
const ADJUSTMENT_COLUMNS = `adjustment_id,assessment_id,payment_id,court_id,adjustment_type,original_amount_minor,
  amount_delta_minor,resulting_amount_minor,currency,status,reason,requested_by_subject,requested_at,
  decided_by_subject,decided_at,decision_reason,applied_at`;
const REFUND_COLUMNS = `refund_request_id,payment_id,court_id,amount_minor,currency,reason,status,
  requested_by_subject,requested_at,decided_by_subject,decided_at,decision_reason,
  provider_refund_reference,completed_by_subject,completed_at`;

function conflict(code, message) { const error = new Error(message); error.code = code; return error; }
function iso(value) { return value instanceof Date ? value.toISOString() : value; }
function mapSchedule(row) {
  if (!row) return null;
  return Object.freeze({ feeScheduleId:row.fee_schedule_id,courtId:row.court_id||null,caseTypeCode:row.case_type_code,
    feeCode:row.fee_code,description:row.description,amountMinor:Number(row.amount_minor),currency:row.currency,
    effectiveFrom:iso(row.effective_from),effectiveTo:iso(row.effective_to)||null,status:row.status,
    createdBy:row.created_by_subject,createdAt:iso(row.created_at),activatedBy:row.activated_by_subject||null,
    activatedAt:iso(row.activated_at)||null,retiredBy:row.retired_by_subject||null,retiredAt:iso(row.retired_at)||null });
}
function mapAdjustment(row) {
  if (!row) return null;
  return Object.freeze({ adjustmentId:row.adjustment_id,assessmentId:row.assessment_id,paymentId:row.payment_id||null,
    courtId:row.court_id,adjustmentType:row.adjustment_type,originalAmountMinor:Number(row.original_amount_minor),
    amountDeltaMinor:Number(row.amount_delta_minor),resultingAmountMinor:Number(row.resulting_amount_minor),currency:row.currency,
    status:row.status,reason:row.reason,requestedBy:row.requested_by_subject,requestedAt:iso(row.requested_at),
    decidedBy:row.decided_by_subject||null,decidedAt:iso(row.decided_at)||null,decisionReason:row.decision_reason||null,
    appliedAt:iso(row.applied_at)||null });
}
function mapRefund(row) {
  if (!row) return null;
  return Object.freeze({ refundRequestId:row.refund_request_id,paymentId:row.payment_id,courtId:row.court_id,
    amountMinor:Number(row.amount_minor),currency:row.currency,reason:row.reason,status:row.status,
    requestedBy:row.requested_by_subject,requestedAt:iso(row.requested_at),decidedBy:row.decided_by_subject||null,
    decidedAt:iso(row.decided_at)||null,decisionReason:row.decision_reason||null,
    providerRefundReference:row.provider_refund_reference||null,completedBy:row.completed_by_subject||null,
    completedAt:iso(row.completed_at)||null });
}
function mapReconciliation(row) {
  if (!row) return null;
  return Object.freeze({ reconciliationId:row.reconciliation_id,paymentId:row.payment_id,courtId:row.court_id,status:row.status,
    preparedBy:row.prepared_by_subject,preparedAt:iso(row.prepared_at),certifiedBy:row.certified_by_subject||null,
    certifiedAt:iso(row.certified_at)||null,exceptionCode:row.exception_code||null,exceptionNote:row.exception_note||null,
    rejectionReason:row.rejection_reason||null,rejectedBy:row.rejected_by_subject||null,rejectedAt:iso(row.rejected_at)||null });
}

function installFinanceCompletionRepository(PostgresRepository) {
  if (!PostgresRepository?.prototype) throw new TypeError('PostgresRepository constructor is required');
  const proto = PostgresRepository.prototype;
  if (proto.__financeCompletionRepositoryInstalled) return;
  Object.defineProperty(proto,'__financeCompletionRepositoryInstalled',{value:true,enumerable:false,writable:false,configurable:false});

  proto.createFeeSchedule = async function createFeeSchedule({ feeScheduleId, courtId, caseTypeCode, feeCode, description, amountMinor, currency, effectiveFrom, effectiveTo, actorSubject, at }) {
    const result = await this.db.query(`INSERT INTO finance.fee_schedules
      (fee_schedule_id,court_id,case_type_code,fee_code,description,amount_minor,currency,effective_from,effective_to,status,created_by_subject,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11)
      RETURNING ${SCHEDULE_COLUMNS}`,
      [feeScheduleId,courtId||null,caseTypeCode,feeCode,description,amountMinor,currency,effectiveFrom,effectiveTo||null,actorSubject,at]);
    return mapSchedule(result.rows[0]);
  };

  proto.listFeeSchedules = async function listFeeSchedules({ courtIds, status = null } = {}) {
    const result = await this.db.query(`SELECT ${SCHEDULE_COLUMNS} FROM finance.fee_schedules
      WHERE (court_id IS NULL OR court_id=ANY($1::uuid[])) AND ($2::varchar IS NULL OR status=$2)
      ORDER BY effective_from DESC,fee_code,case_type_code`, [courtIds||[],status]);
    return result.rows.map(mapSchedule);
  };

  proto.getFeeSchedule = async function getFeeSchedule(feeScheduleId) {
    const result = await this.db.query(`SELECT ${SCHEDULE_COLUMNS} FROM finance.fee_schedules WHERE fee_schedule_id=$1`, [feeScheduleId]);
    return mapSchedule(result.rows[0]);
  };

  proto.activateFeeSchedule = async function activateFeeSchedule({ feeScheduleId, actorSubject, at }) {
    const result = await this.db.query(`WITH candidate AS MATERIALIZED (
      SELECT * FROM finance.fee_schedules WHERE fee_schedule_id=$1 AND status='DRAFT' FOR UPDATE
    ), activated AS (
      UPDATE finance.fee_schedules fs SET status='ACTIVE',activated_by_subject=$2,activated_at=$3
      FROM candidate c
      WHERE fs.fee_schedule_id=c.fee_schedule_id
        AND NOT EXISTS (
          SELECT 1 FROM finance.fee_schedules other
          WHERE other.fee_schedule_id<>c.fee_schedule_id AND other.status='ACTIVE'
            AND other.court_id IS NOT DISTINCT FROM c.court_id
            AND other.case_type_code=c.case_type_code AND other.fee_code=c.fee_code
            AND (other.effective_to IS NULL OR other.effective_to>=c.effective_from)
            AND (c.effective_to IS NULL OR c.effective_to>=other.effective_from)
        )
      RETURNING fs.${SCHEDULE_COLUMNS.replaceAll(',',',fs.')}
    ) SELECT * FROM activated`, [feeScheduleId,actorSubject,at]);
    if (result.rows.length!==1) throw conflict('FEE_SCHEDULE_STATE_CONFLICT','Fee schedule cannot be activated or overlaps an active schedule');
    return mapSchedule(result.rows[0]);
  };

  proto.retireFeeSchedule = async function retireFeeSchedule({ feeScheduleId, actorSubject, at }) {
    const result = await this.db.query(`UPDATE finance.fee_schedules
      SET status='RETIRED',retired_by_subject=$2,retired_at=$3
      WHERE fee_schedule_id=$1 AND status='ACTIVE' RETURNING ${SCHEDULE_COLUMNS}`, [feeScheduleId,actorSubject,at]);
    if (result.rows.length!==1) throw conflict('FEE_SCHEDULE_STATE_CONFLICT','Fee schedule cannot be retired from its current state');
    return mapSchedule(result.rows[0]);
  };

  proto.createPaymentAdjustment = async function createPaymentAdjustment({ adjustmentId, assessmentId, paymentId, adjustmentType, amountDeltaMinor, reason, actorSubject, at }) {
    const result = await this.db.query(`WITH assessment AS MATERIALIZED (
      SELECT fa.assessment_id,fa.court_id,fa.amount_minor,fa.currency
      FROM finance.fee_assessments fa WHERE fa.assessment_id=$2 FOR UPDATE
    ), payment AS MATERIALIZED (
      SELECT p.payment_id,p.assessment_id,p.status,p.currency
      FROM finance.payments p WHERE p.payment_id=$3 FOR UPDATE
    ), eligible AS (
      SELECT a.*,p.payment_id FROM assessment a LEFT JOIN payment p ON p.assessment_id=a.assessment_id
      WHERE ($3::uuid IS NULL OR p.payment_id=$3)
        AND (a.amount_minor+$5)>=0
        AND (p.payment_id IS NULL OR p.currency=a.currency)
    ) INSERT INTO finance.payment_adjustments
      (adjustment_id,assessment_id,payment_id,court_id,adjustment_type,original_amount_minor,amount_delta_minor,resulting_amount_minor,currency,status,reason,requested_by_subject,requested_at)
      SELECT $1,assessment_id,payment_id,court_id,$4,amount_minor,$5,amount_minor+$5,currency,'REQUESTED',$6,$7,$8 FROM eligible
      RETURNING ${ADJUSTMENT_COLUMNS}`,
      [adjustmentId,assessmentId,paymentId||null,adjustmentType,amountDeltaMinor,reason,actorSubject,at]);
    if (result.rows.length!==1) throw conflict('FINANCE_ADJUSTMENT_CONFLICT','Adjustment is not eligible for request');
    return mapAdjustment(result.rows[0]);
  };

  proto.getPaymentAdjustment = async function getPaymentAdjustment(adjustmentId) {
    const result = await this.db.query(`SELECT ${ADJUSTMENT_COLUMNS} FROM finance.payment_adjustments WHERE adjustment_id=$1`, [adjustmentId]);
    return mapAdjustment(result.rows[0]);
  };

  proto.approvePaymentAdjustment = async function approvePaymentAdjustment({ adjustmentId, actorSubject, decisionReason, at }) {
    const result = await this.db.query(`WITH adjustment AS MATERIALIZED (
      SELECT * FROM finance.payment_adjustments WHERE adjustment_id=$1 FOR UPDATE
    ), payment AS MATERIALIZED (
      SELECT p.payment_id,p.status FROM finance.payments p JOIN adjustment a ON a.payment_id=p.payment_id FOR UPDATE OF p
    ), approved AS (
      UPDATE finance.payment_adjustments pa
      SET status='APPROVED',decided_by_subject=$2,decided_at=$4,decision_reason=$3
      FROM adjustment a LEFT JOIN payment p ON true
      WHERE pa.adjustment_id=a.adjustment_id AND a.status='REQUESTED'
        AND a.requested_by_subject <> $2
        AND (p.status IS NULL OR p.status IN ('PENDING','FAILED','CANCELLED'))
      RETURNING pa.${ADJUSTMENT_COLUMNS.replaceAll(',',',pa.')}
    ) SELECT * FROM approved`, [adjustmentId,actorSubject,decisionReason,at]);
    if (result.rows.length!==1) throw conflict('FINANCE_ADJUSTMENT_CONFLICT','Adjustment state or maker-checker conflict');
    return mapAdjustment(result.rows[0]);
  };

  proto.rejectPaymentAdjustment = async function rejectPaymentAdjustment({ adjustmentId, actorSubject, decisionReason, at }) {
    const result = await this.db.query(`UPDATE finance.payment_adjustments
      SET status='REJECTED',decided_by_subject=$2,decided_at=$4,decision_reason=$3
      WHERE adjustment_id=$1 AND status='REQUESTED' AND requested_by_subject<>$2
      RETURNING ${ADJUSTMENT_COLUMNS}`, [adjustmentId,actorSubject,decisionReason,at]);
    if (result.rows.length!==1) throw conflict('FINANCE_ADJUSTMENT_CONFLICT','Adjustment state or maker-checker conflict');
    return mapAdjustment(result.rows[0]);
  };

  proto.createRefundRequest = async function createRefundRequest({ refundRequestId, paymentId, amountMinor, reason, actorSubject, at }) {
    const result = await this.db.query(`WITH payment AS MATERIALIZED (
      SELECT p.payment_id,p.court_id,p.amount_minor,p.currency,p.status
      FROM finance.payments p WHERE p.payment_id=$2 AND p.status='CONFIRMED' FOR UPDATE
    ), reserved AS (
      SELECT COALESCE(SUM(r.amount_minor),0)::bigint AS amount_minor
      FROM finance.refund_requests r JOIN payment p ON p.payment_id=r.payment_id
      WHERE r.status IN ('REQUESTED','APPROVED','COMPLETED')
    ), eligible AS (
      SELECT p.* FROM payment p CROSS JOIN reserved r WHERE r.amount_minor+$3 <= p.amount_minor
    ) INSERT INTO finance.refund_requests
      (refund_request_id,payment_id,court_id,amount_minor,currency,reason,status,requested_by_subject,requested_at)
      SELECT $1,payment_id,court_id,$3,currency,$4,'REQUESTED',$5,$6 FROM eligible
      RETURNING ${REFUND_COLUMNS}`,
      [refundRequestId,paymentId,amountMinor,reason,actorSubject,at]);
    if (result.rows.length!==1) throw conflict('FINANCE_REFUND_CONFLICT','Refund is not eligible or would exceed the confirmed payment amount');
    return mapRefund(result.rows[0]);
  };

  proto.getRefundRequest = async function getRefundRequest(refundRequestId) {
    const result = await this.db.query(`SELECT ${REFUND_COLUMNS} FROM finance.refund_requests WHERE refund_request_id=$1`, [refundRequestId]);
    return mapRefund(result.rows[0]);
  };

  proto.approveRefundRequest = async function approveRefundRequest({ refundRequestId, actorSubject, decisionReason, at }) {
    const result = await this.db.query(`WITH request AS MATERIALIZED (
      SELECT * FROM finance.refund_requests WHERE refund_request_id=$1 FOR UPDATE
    ), payment AS MATERIALIZED (
      SELECT p.payment_id,p.status FROM finance.payments p JOIN request r ON r.payment_id=p.payment_id FOR UPDATE OF p
    ), approved AS (
      UPDATE finance.refund_requests rr SET status='APPROVED',decided_by_subject=$2,decided_at=$4,decision_reason=$3
      FROM request r JOIN payment p ON p.payment_id=r.payment_id
      WHERE rr.refund_request_id=r.refund_request_id AND r.status='REQUESTED'
        AND r.requested_by_subject <> $2 AND p.status='CONFIRMED'
      RETURNING rr.${REFUND_COLUMNS.replaceAll(',',',rr.')}
    ) SELECT * FROM approved`, [refundRequestId,actorSubject,decisionReason,at]);
    if (result.rows.length!==1) throw conflict('FINANCE_REFUND_CONFLICT','Refund state or maker-checker conflict');
    return mapRefund(result.rows[0]);
  };

  proto.rejectRefundRequest = async function rejectRefundRequest({ refundRequestId, actorSubject, decisionReason, at }) {
    const result = await this.db.query(`UPDATE finance.refund_requests
      SET status='REJECTED',decided_by_subject=$2,decided_at=$4,decision_reason=$3
      WHERE refund_request_id=$1 AND status='REQUESTED' AND requested_by_subject<>$2
      RETURNING ${REFUND_COLUMNS}`, [refundRequestId,actorSubject,decisionReason,at]);
    if (result.rows.length!==1) throw conflict('FINANCE_REFUND_CONFLICT','Refund state or maker-checker conflict');
    return mapRefund(result.rows[0]);
  };

  proto.completeRefundRequest = async function completeRefundRequest({ refundRequestId, actorSubject, providerRefundReference, at }) {
    const result = await this.db.query(`WITH request AS MATERIALIZED (
      SELECT * FROM finance.refund_requests WHERE refund_request_id=$1 AND status='APPROVED' FOR UPDATE
    ), payment AS MATERIALIZED (
      SELECT p.* FROM finance.payments p JOIN request r ON r.payment_id=p.payment_id WHERE p.status='CONFIRMED' FOR UPDATE OF p
    ), completed AS (
      UPDATE finance.refund_requests rr
      SET status='COMPLETED',provider_refund_reference=$3,completed_by_subject=$2,completed_at=$4
      FROM request r JOIN payment p ON p.payment_id=r.payment_id
      WHERE rr.refund_request_id=r.refund_request_id AND p.refunded_amount_minor+r.amount_minor<=p.amount_minor
      RETURNING rr.*
    ), payment_update AS (
      UPDATE finance.payments p
      SET refunded_amount_minor=p.refunded_amount_minor+c.amount_minor,
          status=CASE WHEN p.refunded_amount_minor+c.amount_minor=p.amount_minor THEN 'REFUNDED' ELSE p.status END
      FROM completed c WHERE p.payment_id=c.payment_id
      RETURNING p.payment_id
    ) SELECT ${REFUND_COLUMNS} FROM completed`, [refundRequestId,actorSubject,providerRefundReference,at]);
    if (result.rows.length!==1) throw conflict('FINANCE_REFUND_CONFLICT','Refund is not approved or cannot be completed safely');
    return mapRefund(result.rows[0]);
  };

  proto.rejectReconciliation = async function rejectReconciliation({ reconciliationId, actorSubject, reason, exceptionCode, at }) {
    const result = await this.db.query(`UPDATE finance.reconciliations
      SET status='REJECTED',exception_code=$4,rejection_reason=$3,rejected_by_subject=$2,rejected_at=$5
      WHERE reconciliation_id=$1 AND status='PREPARED' AND prepared_by_subject <> $2
      RETURNING reconciliation_id,payment_id,court_id,status,prepared_by_subject,prepared_at,certified_by_subject,certified_at,
        exception_code,exception_note,rejection_reason,rejected_by_subject,rejected_at`,
      [reconciliationId,actorSubject,reason,exceptionCode,at]);
    if (result.rows.length!==1) throw conflict('RECONCILIATION_STATE_CONFLICT','Reconciliation state or maker-checker conflict');
    return mapReconciliation(result.rows[0]);
  };

  proto.listReconciliationExceptions = async function listReconciliationExceptions({ courtIds }) {
    const result = await this.db.query(`SELECT reconciliation_id,payment_id,court_id,status,prepared_by_subject,prepared_at,
      certified_by_subject,certified_at,exception_code,exception_note,rejection_reason,rejected_by_subject,rejected_at
      FROM finance.reconciliations
      WHERE court_id=ANY($1::uuid[]) AND (status='REJECTED' OR exception_code IS NOT NULL)
      ORDER BY prepared_at DESC`, [courtIds||[]]);
    return result.rows.map(mapReconciliation);
  };
}

module.exports = { installFinanceCompletionRepository, mapSchedule, mapAdjustment, mapRefund, mapReconciliation };
