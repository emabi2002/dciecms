'use strict';

const CASE_COLUMNS = `case_id,case_number,filing_id,payment_id,court_id,case_type_code,status,
  opened_by_subject,opened_at,assigned_to_subject,assigned_by_subject,assigned_at,
  disposition_code,disposed_by_subject,disposed_at,closure_code,closed_by_subject,closed_at,
  reopened_by_subject,reopened_at`;

const CONTROL_COLUMNS = `case_record_control_id,case_id,court_id,status,retention_class_code,
  retention_trigger_at,disposition_eligible_at,archived_at,archived_by_subject,legal_hold,
  legal_hold_reference,legal_hold_reason,legal_hold_set_at,legal_hold_set_by_subject,
  legal_hold_released_at,legal_hold_released_by_subject,created_at,updated_at`;

const DISPOSAL_COLUMNS = `disposal_request_id,case_record_control_id,case_id,court_id,status,reason,
  requested_by_subject,requested_at,decided_by_subject,decided_at,decision_reason`;

function mapLifecycleCase(row) {
  if (!row) return null;
  return Object.freeze({
    caseId: row.case_id,
    caseNumber: row.case_number,
    filingId: row.filing_id,
    paymentId: row.payment_id,
    courtId: row.court_id,
    caseTypeCode: row.case_type_code,
    status: row.status,
    openedBy: row.opened_by_subject,
    openedAt: row.opened_at,
    assignedToSubject: row.assigned_to_subject || null,
    assignedBySubject: row.assigned_by_subject || null,
    assignedAt: row.assigned_at || null,
    dispositionCode: row.disposition_code || null,
    disposedBy: row.disposed_by_subject || null,
    disposedAt: row.disposed_at || null,
    closureCode: row.closure_code || null,
    closedBy: row.closed_by_subject || null,
    closedAt: row.closed_at || null,
    reopenedBy: row.reopened_by_subject || null,
    reopenedAt: row.reopened_at || null
  });
}

function mapControl(row) {
  if (!row) return null;
  return Object.freeze({
    caseRecordControlId: row.case_record_control_id,
    caseId: row.case_id,
    courtId: row.court_id,
    status: row.status,
    retentionClassCode: row.retention_class_code || null,
    retentionTriggerAt: row.retention_trigger_at || null,
    dispositionEligibleAt: row.disposition_eligible_at || null,
    archivedAt: row.archived_at || null,
    archivedBy: row.archived_by_subject || null,
    legalHold: Boolean(row.legal_hold),
    legalHoldReference: row.legal_hold_reference || null,
    legalHoldReason: row.legal_hold_reason || null,
    legalHoldSetAt: row.legal_hold_set_at || null,
    legalHoldSetBy: row.legal_hold_set_by_subject || null,
    legalHoldReleasedAt: row.legal_hold_released_at || null,
    legalHoldReleasedBy: row.legal_hold_released_by_subject || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapDisposalRequest(row) {
  if (!row) return null;
  return Object.freeze({
    disposalRequestId: row.disposal_request_id,
    caseRecordControlId: row.case_record_control_id,
    caseId: row.case_id,
    courtId: row.court_id,
    status: row.status,
    reason: row.reason,
    requestedBy: row.requested_by_subject,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by_subject || null,
    decidedAt: row.decided_at || null,
    decisionReason: row.decision_reason || null
  });
}

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function installCaseLifecycleRecordsRepository(PostgresRepository) {
  if (!PostgresRepository?.prototype) throw new TypeError('PostgresRepository constructor is required');
  const proto = PostgresRepository.prototype;
  if (proto.__caseLifecycleRecordsRepositoryInstalled) return;

  Object.defineProperty(proto, '__caseLifecycleRecordsRepositoryInstalled', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  proto.hasActiveCaseHearing = async function hasActiveCaseHearing(caseId) {
    const result = await this.db.query(`SELECT true AS active
      FROM judicial.hearings
      WHERE case_id=$1 AND status IN ('SCHEDULED','IN_PROGRESS')
      LIMIT 1`, [caseId]);
    return result.rows.length > 0;
  };

  proto.getIssuedJudgmentForCase = async function getIssuedJudgmentForCase(judgmentId, caseId) {
    const result = await this.db.query(`SELECT judgment_id,case_id,court_id,status,decision_type,issued_at
      FROM judicial.judgments
      WHERE judgment_id=$1 AND case_id=$2 AND status='ISSUED'`, [judgmentId, caseId]);
    const row = result.rows[0];
    if (!row) return null;
    return Object.freeze({
      judgmentId: row.judgment_id,
      caseId: row.case_id,
      courtId: row.court_id,
      status: row.status,
      decisionType: row.decision_type,
      issuedAt: row.issued_at
    });
  };

  proto.disposeCase = async function disposeCase({ caseId, dispositionCode, reason, judgmentId, actorSubject, at }) {
    const result = await this.db.query(`WITH transitioned AS (
      UPDATE case_mgmt.cases
      SET status='DISPOSED',disposition_code=$2,disposed_by_subject=$5,disposed_at=$6
      WHERE case_id=$1 AND status='ASSIGNED'
      RETURNING ${CASE_COLUMNS}
    ), evidence AS (
      INSERT INTO case_mgmt.case_lifecycle_events
        (case_id,court_id,event_type,event_code,reason,judgment_id,actor_subject,occurred_at)
      SELECT case_id,court_id,'DISPOSED',$2,$3,$4,$5,$6 FROM transitioned
      RETURNING lifecycle_event_id
    )
    SELECT * FROM transitioned`, [caseId, dispositionCode, reason, judgmentId || null, actorSubject, at]);
    if (result.rows.length !== 1) throw conflict('CASE_LIFECYCLE_CONFLICT', 'Case is not eligible for disposition');
    return mapLifecycleCase(result.rows[0]);
  };

  proto.closeCase = async function closeCase({ caseId, closureCode, reason, actorSubject, at }) {
    const result = await this.db.query(`WITH transitioned AS (
      UPDATE case_mgmt.cases
      SET status='CLOSED',closure_code=$2,closed_by_subject=$4,closed_at=$5
      WHERE case_id=$1 AND status='DISPOSED'
      RETURNING ${CASE_COLUMNS}
    ), evidence AS (
      INSERT INTO case_mgmt.case_lifecycle_events
        (case_id,court_id,event_type,event_code,reason,actor_subject,occurred_at)
      SELECT case_id,court_id,'CLOSED',$2,$3,$4,$5 FROM transitioned
      RETURNING lifecycle_event_id
    ), record_control AS (
      INSERT INTO records.case_record_controls (case_id,court_id,status,created_at,updated_at)
      SELECT case_id,court_id,'ACTIVE',$5,$5 FROM transitioned
      ON CONFLICT (case_id) DO UPDATE
        SET status='ACTIVE',updated_at=EXCLUDED.updated_at
      RETURNING case_record_control_id
    )
    SELECT * FROM transitioned`, [caseId, closureCode, reason, actorSubject, at]);
    if (result.rows.length !== 1) throw conflict('CASE_LIFECYCLE_CONFLICT', 'Case is not eligible for closure');
    return mapLifecycleCase(result.rows[0]);
  };

  proto.reopenCase = async function reopenCase({ caseId, reason, actorSubject, at }) {
    const result = await this.db.query(`WITH transitioned AS (
      UPDATE case_mgmt.cases
      SET status='AWAITING_ASSIGNMENT',assigned_to_subject=NULL,assigned_by_subject=NULL,assigned_at=NULL,
          reopened_by_subject=$3,reopened_at=$4
      WHERE case_id=$1 AND status='CLOSED'
      RETURNING ${CASE_COLUMNS}
    ), evidence AS (
      INSERT INTO case_mgmt.case_lifecycle_events
        (case_id,court_id,event_type,reason,actor_subject,occurred_at)
      SELECT case_id,court_id,'REOPENED',$2,$3,$4 FROM transitioned
      RETURNING lifecycle_event_id
    ), reset_control AS (
      UPDATE records.case_record_controls rc
      SET status='ACTIVE',retention_trigger_at=NULL,disposition_eligible_at=NULL,updated_at=$4
      FROM transitioned t
      WHERE rc.case_id=t.case_id
      RETURNING rc.case_record_control_id
    ), cancelled_requests AS (
      UPDATE records.disposal_requests dr
      SET status='CANCELLED',decided_by_subject=$3,decided_at=$4,decision_reason='CASE_REOPENED'
      FROM transitioned t
      WHERE dr.case_id=t.case_id AND dr.status='REQUESTED'
      RETURNING dr.disposal_request_id
    )
    SELECT * FROM transitioned`, [caseId, reason, actorSubject, at]);
    if (result.rows.length !== 1) throw conflict('CASE_LIFECYCLE_CONFLICT', 'Case is not eligible for reopening');
    return mapLifecycleCase(result.rows[0]);
  };

  proto.getCaseRecordControl = async function getCaseRecordControl(caseId) {
    const result = await this.db.query(`SELECT ${CONTROL_COLUMNS}
      FROM records.case_record_controls WHERE case_id=$1`, [caseId]);
    return mapControl(result.rows[0]);
  };

  proto.assignRetention = async function assignRetention({ caseId, retentionClassCode, retentionTriggerAt, dispositionEligibleAt, at }) {
    const result = await this.db.query(`UPDATE records.case_record_controls rc
      SET retention_class_code=$2,retention_trigger_at=$3,disposition_eligible_at=$4,updated_at=$5
      FROM case_mgmt.cases c
      WHERE rc.case_id=$1 AND c.case_id=rc.case_id AND c.status='CLOSED'
        AND rc.status='ACTIVE' AND rc.legal_hold=false
      RETURNING ${CONTROL_COLUMNS}`, [caseId, retentionClassCode, retentionTriggerAt, dispositionEligibleAt, at]);
    if (result.rows.length !== 1) throw conflict('RECORDS_STATE_CONFLICT', 'Case record is not eligible for retention assignment');
    return mapControl(result.rows[0]);
  };

  proto.archiveCaseRecord = async function archiveCaseRecord({ caseId, actorSubject, at }) {
    const result = await this.db.query(`UPDATE records.case_record_controls rc
      SET status='ARCHIVED',archived_at=$3,archived_by_subject=$2,updated_at=$3
      FROM case_mgmt.cases c
      WHERE rc.case_id=$1 AND c.case_id=rc.case_id AND c.status='CLOSED'
        AND rc.status='ACTIVE' AND rc.retention_class_code IS NOT NULL
      RETURNING ${CONTROL_COLUMNS}`, [caseId, actorSubject, at]);
    if (result.rows.length !== 1) throw conflict('RECORDS_STATE_CONFLICT', 'Case record is not eligible for archive');
    return mapControl(result.rows[0]);
  };

  proto.setCaseLegalHold = async function setCaseLegalHold({ caseId, reference, reason, actorSubject, at }) {
    const result = await this.db.query(`UPDATE records.case_record_controls
      SET legal_hold=true,legal_hold_reference=$2,legal_hold_reason=$3,
          legal_hold_set_at=$5,legal_hold_set_by_subject=$4,
          legal_hold_released_at=NULL,legal_hold_released_by_subject=NULL,updated_at=$5
      WHERE case_id=$1 AND status <> 'DISPOSAL_APPROVED'
      RETURNING ${CONTROL_COLUMNS}`, [caseId, reference, reason, actorSubject, at]);
    if (result.rows.length !== 1) throw conflict('RECORDS_STATE_CONFLICT', 'Case record cannot be placed on legal hold');
    return mapControl(result.rows[0]);
  };

  proto.releaseCaseLegalHold = async function releaseCaseLegalHold({ caseId, actorSubject, at }) {
    const result = await this.db.query(`UPDATE records.case_record_controls
      SET legal_hold=false,legal_hold_released_at=$3,legal_hold_released_by_subject=$2,updated_at=$3
      WHERE case_id=$1 AND legal_hold=true AND status <> 'DISPOSAL_APPROVED'
      RETURNING ${CONTROL_COLUMNS}`, [caseId, actorSubject, at]);
    if (result.rows.length !== 1) throw conflict('RECORDS_STATE_CONFLICT', 'Case record legal hold is not releasable');
    return mapControl(result.rows[0]);
  };

  proto.hasDocumentLegalHold = async function hasDocumentLegalHold(caseId) {
    const result = await this.db.query(`SELECT true AS held
      FROM documents.documents d
      JOIN case_mgmt.cases c ON c.filing_id=d.filing_id
      WHERE c.case_id=$1 AND d.legal_hold=true
      LIMIT 1`, [caseId]);
    return result.rows.length > 0;
  };

  proto.createDisposalRequest = async function createDisposalRequest({ disposalRequestId, caseId, reason, actorSubject, at }) {
    const result = await this.db.query(`WITH document_guard AS (
      SELECT d.document_id,d.legal_hold
      FROM documents.documents d
      JOIN case_mgmt.cases cg ON cg.filing_id=d.filing_id
      WHERE cg.case_id=$1
      FOR UPDATE OF d
    ), eligible AS (
      SELECT rc.case_record_control_id,rc.case_id,rc.court_id
      FROM records.case_record_controls rc
      JOIN case_mgmt.cases c ON c.case_id=rc.case_id
      WHERE rc.case_id=$1 AND c.status='CLOSED' AND rc.status='ARCHIVED'
        AND rc.legal_hold=false AND rc.disposition_eligible_at IS NOT NULL
        AND rc.disposition_eligible_at <= $5
        AND NOT EXISTS (SELECT 1 FROM document_guard dg WHERE dg.legal_hold=true)
      FOR UPDATE OF rc, c
    ), requested AS (
      INSERT INTO records.disposal_requests
        (disposal_request_id,case_record_control_id,case_id,court_id,status,reason,requested_by_subject,requested_at)
      SELECT $2,case_record_control_id,case_id,court_id,'REQUESTED',$3,$4,$5 FROM eligible
      RETURNING ${DISPOSAL_COLUMNS}
    ), control AS (
      UPDATE records.case_record_controls rc
      SET status='DISPOSAL_REQUESTED',updated_at=$5
      FROM requested r
      WHERE rc.case_record_control_id=r.case_record_control_id
      RETURNING rc.case_record_control_id
    )
    SELECT * FROM requested`, [caseId, disposalRequestId, reason, actorSubject, at]);
    if (result.rows.length !== 1) throw conflict('RECORDS_STATE_CONFLICT', 'Case record is not eligible for disposal request');
    return mapDisposalRequest(result.rows[0]);
  };

  proto.getDisposalRequest = async function getDisposalRequest(disposalRequestId) {
    const result = await this.db.query(`SELECT ${DISPOSAL_COLUMNS}
      FROM records.disposal_requests WHERE disposal_request_id=$1`, [disposalRequestId]);
    return mapDisposalRequest(result.rows[0]);
  };

  proto.approveDisposalRequest = async function approveDisposalRequest({ disposalRequestId, actorSubject, decisionReason, at }) {
    const result = await this.db.query(`WITH request_case AS MATERIALIZED (
      SELECT dr.case_id
      FROM records.disposal_requests dr
      WHERE dr.disposal_request_id=$1
    ), control_guard AS MATERIALIZED (
      SELECT rc.case_record_control_id,rc.case_id
      FROM records.case_record_controls rc
      JOIN case_mgmt.cases c ON c.case_id=rc.case_id
      JOIN request_case rq ON rq.case_id=rc.case_id
      FOR UPDATE OF rc, c
    ), document_guard AS MATERIALIZED (
      SELECT d.document_id,d.legal_hold
      FROM documents.documents d
      JOIN case_mgmt.cases cg ON cg.filing_id=d.filing_id
      JOIN request_case rq ON rq.case_id=cg.case_id
      FOR UPDATE OF d
    ), approved AS (
      UPDATE records.disposal_requests dr
      SET status='APPROVED',decided_by_subject=$2,decided_at=$4,decision_reason=$3
      FROM records.case_record_controls rc
      JOIN case_mgmt.cases c ON c.case_id=rc.case_id
      JOIN control_guard guard ON guard.case_record_control_id=rc.case_record_control_id
      WHERE dr.disposal_request_id=$1
        AND dr.case_record_control_id=rc.case_record_control_id
        AND dr.status='REQUESTED'
        AND dr.requested_by_subject <> $2
        AND rc.status='DISPOSAL_REQUESTED'
        AND rc.legal_hold=false
        AND rc.disposition_eligible_at IS NOT NULL
        AND rc.disposition_eligible_at <= $4
        AND c.status='CLOSED'
        AND NOT EXISTS (SELECT 1 FROM document_guard dg WHERE dg.legal_hold=true)
      RETURNING dr.${DISPOSAL_COLUMNS.replaceAll(',', ',dr.')}
    ), control AS (
      UPDATE records.case_record_controls rc
      SET status='DISPOSAL_APPROVED',updated_at=$4
      FROM approved a
      WHERE rc.case_record_control_id=a.case_record_control_id
      RETURNING rc.case_record_control_id
    )
    SELECT * FROM approved`, [disposalRequestId, actorSubject, decisionReason, at]);
    if (result.rows.length !== 1) throw conflict('RECORDS_SOD_CONFLICT', 'Disposal request is not approvable');
    return mapDisposalRequest(result.rows[0]);
  };

  proto.rejectDisposalRequest = async function rejectDisposalRequest({ disposalRequestId, actorSubject, decisionReason, at }) {
    const result = await this.db.query(`WITH request_case AS MATERIALIZED (
      SELECT dr.case_id
      FROM records.disposal_requests dr
      WHERE dr.disposal_request_id=$1
    ), control_guard AS MATERIALIZED (
      SELECT rc.case_record_control_id,rc.case_id
      FROM records.case_record_controls rc
      JOIN case_mgmt.cases c ON c.case_id=rc.case_id
      JOIN request_case rq ON rq.case_id=rc.case_id
      FOR UPDATE OF rc, c
    ), rejected AS (
      UPDATE records.disposal_requests dr
      SET status='REJECTED',decided_by_subject=$2,decided_at=$4,decision_reason=$3
      FROM records.case_record_controls rc
      JOIN case_mgmt.cases c ON c.case_id=rc.case_id
      JOIN control_guard guard ON guard.case_record_control_id=rc.case_record_control_id
      WHERE dr.disposal_request_id=$1
        AND dr.case_record_control_id=rc.case_record_control_id
        AND dr.status='REQUESTED'
        AND dr.requested_by_subject <> $2
        AND c.status='CLOSED'
        AND rc.status='DISPOSAL_REQUESTED'
      RETURNING dr.${DISPOSAL_COLUMNS.replaceAll(',', ',dr.')}
    ), control AS (
      UPDATE records.case_record_controls rc
      SET status='ARCHIVED',updated_at=$4
      FROM rejected r
      WHERE rc.case_record_control_id=r.case_record_control_id
      RETURNING rc.case_record_control_id
    )
    SELECT * FROM rejected`, [disposalRequestId, actorSubject, decisionReason, at]);
    if (result.rows.length !== 1) throw conflict('RECORDS_SOD_CONFLICT', 'Disposal request is not rejectable');
    return mapDisposalRequest(result.rows[0]);
  };
}

module.exports = {
  installCaseLifecycleRecordsRepository,
  mapLifecycleCase,
  mapControl,
  mapDisposalRequest
};