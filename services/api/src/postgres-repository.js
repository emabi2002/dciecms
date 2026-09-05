'use strict';

function mapParty(row) {
  if (!row) return null;
  return Object.freeze({ partyId: row.party_id, courtId: row.court_id, partyType: row.party_type, displayName: row.display_name, createdAt: row.created_at });
}
function mapTask(row) {
  if (!row) return null;
  return Object.freeze({ taskId: row.task_id, filingId: row.filing_id, courtId: row.court_id, taskType: row.task_type, assignedRole: row.assigned_role_code, priority: row.priority || 'NORMAL', status: row.status, dueAt: row.due_at || null, createdAt: row.created_at, completedAt: row.completed_at || null, completedBy: row.completed_by_subject || null });
}
function mapFiling(row) {
  if (!row) return null;
  return Object.freeze({ filingId: row.filing_id, filingReference: row.filing_reference, courtId: row.court_id, caseTypeCode: row.case_type_code, filerPartyId: row.filer_party_id, status: row.status, createdBy: row.created_by, createdAt: row.created_at, submittedAt: row.submitted_at || null, validatedAt: row.validated_at || null, validatedBy: row.validated_by_subject || null, decisionReason: row.decision_reason || null, decisionBy: row.decision_by_subject || null, decisionAt: row.decision_at || null });
}
function mapDocument(row) {
  if (!row) return null;
  return Object.freeze({ documentId: row.document_id, filingId: row.filing_id, courtId: row.court_id, fileName: row.file_name, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes || 0), checksumSha256: row.checksum_sha256, status: row.status, classification: row.classification, createdAt: row.created_at });
}
function mapReceipt(row) {
  if (!row) return null;
  return Object.freeze({ receiptId:row.receipt_id, receiptNumber:row.receipt_number, paymentId:row.payment_id, courtId:row.court_id, amountMinor:Number(row.amount_minor), currency:row.currency, status:row.status, issuedBy:row.issued_by_subject, issuedAt:row.issued_at });
}
function mapReconciliation(row) {
  if (!row) return null;
  return Object.freeze({ reconciliationId:row.reconciliation_id, paymentId:row.payment_id, courtId:row.court_id, status:row.status, preparedBy:row.prepared_by_subject, preparedAt:row.prepared_at, certifiedBy:row.certified_by_subject||null, certifiedAt:row.certified_at||null });
}
function mapCase(row) {
  if (!row) return null;
  return Object.freeze({ caseId:row.case_id, caseNumber:row.case_number, filingId:row.filing_id, paymentId:row.payment_id, courtId:row.court_id, caseTypeCode:row.case_type_code, status:row.status, openedBy:row.opened_by_subject, openedAt:row.opened_at });
}

const FILING_COLUMNS = `filing_id, filing_reference, court_id, case_type_code,
  filer_party_id, status, created_by, created_at, submitted_at,
  validated_at, validated_by_subject, decision_reason, decision_by_subject, decision_at`;
const CASE_COLUMNS = `case_id,case_number,filing_id,payment_id,court_id,case_type_code,status,opened_by_subject,opened_at`;

class PostgresRepository {
  constructor(queryable) {
    if (!queryable || (typeof queryable.query !== 'function' && typeof queryable.connect !== 'function')) throw new TypeError('PostgresRepository requires a pg-compatible queryable or pool');
    this.db = queryable;
  }
  async createParty({ partyId, courtId, partyType, displayName }) {
    const result = await this.db.query(`INSERT INTO case_mgmt.parties (party_id, court_id, party_type, display_name) VALUES ($1, $2, $3, $4) RETURNING party_id, court_id, party_type, display_name, created_at`, [partyId, courtId, partyType, displayName]);
    return mapParty(result.rows[0]);
  }
  async getParty(partyId) {
    const result = await this.db.query(`SELECT party_id, court_id, party_type, display_name, created_at FROM case_mgmt.parties WHERE party_id = $1`, [partyId]);
    return mapParty(result.rows[0]);
  }
  async isCaseTypeActive(caseTypeCode) {
    const result = await this.db.query(`SELECT active FROM config.case_types WHERE case_type_code = $1 AND active = true AND (effective_from IS NULL OR effective_from <= CURRENT_DATE) AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`, [caseTypeCode]);
    return result.rows.length === 1;
  }
  async createFilingDraft({ filingId, filingReference, courtId, caseTypeCode, filerPartyId, createdBy }) {
    const result = await this.db.query(`INSERT INTO registry.filings (filing_id, filing_reference, court_id, case_type_code, filer_party_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${FILING_COLUMNS}`, [filingId, filingReference, courtId, caseTypeCode, filerPartyId, createdBy]);
    return mapFiling(result.rows[0]);
  }
  async getFiling(filingId) {
    const result = await this.db.query(`SELECT ${FILING_COLUMNS} FROM registry.filings WHERE filing_id = $1`, [filingId]);
    return mapFiling(result.rows[0]);
  }
  async listRegistryQueue({ courtIds }) {
    const result = await this.db.query(`SELECT ${FILING_COLUMNS} FROM registry.filings WHERE court_id = ANY($1::uuid[]) AND status='SUBMITTED' ORDER BY submitted_at ASC, created_at ASC`, [courtIds]);
    return result.rows.map(mapFiling);
  }
  async createDocument({ documentId, filingId, courtId, fileName, mimeType, sizeBytes, checksumSha256, classification }) {
    const result = await this.db.query(`INSERT INTO documents.documents (document_id, filing_id, court_id, file_name, mime_type, size_bytes, checksum_sha256, classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING document_id, filing_id, court_id, file_name, mime_type, size_bytes, checksum_sha256, status, classification, created_at`, [documentId, filingId, courtId, fileName, mimeType, sizeBytes, checksumSha256, classification]);
    return mapDocument(result.rows[0]);
  }
  async getDocument(documentId) {
    const result = await this.db.query(`SELECT document_id, filing_id, court_id, file_name, mime_type, size_bytes, checksum_sha256, status, classification, created_at FROM documents.documents WHERE document_id=$1`, [documentId]);
    return mapDocument(result.rows[0]);
  }
  async createRegistryValidationTask({ taskId, filingId, courtId }) {
    const result = await this.db.query(`INSERT INTO workflow.workflow_tasks (task_id, filing_id, court_id, task_type, assigned_role_code, status) VALUES ($1, $2, $3, 'REGISTRY_VALIDATE_FILING', 'REG', 'PENDING') RETURNING task_id, filing_id, court_id, task_type, assigned_role_code, priority, status, due_at, created_at, completed_at, completed_by_subject`, [taskId, filingId, courtId]);
    return mapTask(result.rows[0]);
  }
  async submitFilingAndCreateTask({ filingId, taskId, actorSubject, submittedAt }) {
    if (typeof this.db.connect !== 'function') throw new TypeError('submitFilingAndCreateTask requires a pool with connect()');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const filingResult = await client.query(`UPDATE registry.filings SET status='SUBMITTED', submitted_at=$2 WHERE filing_id=$1 AND status='DRAFT' RETURNING ${FILING_COLUMNS}`, [filingId, submittedAt]);
      if (filingResult.rows.length !== 1) { const e = new Error('Filing was not in DRAFT state'); e.code='FILING_STATE_CONFLICT'; throw e; }
      const filing = filingResult.rows[0];
      await client.query(`INSERT INTO workflow.workflow_tasks (task_id, filing_id, court_id, task_type, assigned_role_code, status) VALUES ($1,$2,$3,'REGISTRY_VALIDATE_FILING','REG','PENDING')`, [taskId, filingId, filing.court_id]);
      await client.query('COMMIT');
      return mapFiling(filing);
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  async listWorkflowTasks({ courtIds, includeCompleted = false }) {
    const statusFilter = includeCompleted ? '' : "AND status <> 'COMPLETED'";
    const result = await this.db.query(`SELECT task_id, filing_id, court_id, task_type, assigned_role_code, priority, status, due_at, created_at, completed_at, completed_by_subject FROM workflow.workflow_tasks WHERE court_id = ANY($1::uuid[]) ${statusFilter} ORDER BY created_at ASC`, [courtIds]);
    return result.rows.map(mapTask);
  }
  async findActiveRegistryValidationTask(filingId) {
    const result = await this.db.query(`SELECT task_id, filing_id, court_id, task_type, assigned_role_code, priority, status, due_at, created_at, completed_at, completed_by_subject FROM workflow.workflow_tasks WHERE filing_id=$1 AND task_type = 'REGISTRY_VALIDATE_FILING' AND status NOT IN ('COMPLETED','CANCELLED') ORDER BY created_at ASC LIMIT 1`, [filingId]);
    return mapTask(result.rows[0]);
  }
  async validateFilingAndCompleteTask({ filingId, taskId, actorSubject, validatedAt }) {
    if (typeof this.db.connect !== 'function') throw new TypeError('validateFilingAndCompleteTask requires a pool with connect()');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const filingResult = await client.query(`UPDATE registry.filings SET status='VALIDATED', validated_at=$2, validated_by_subject=$3 WHERE filing_id=$1 AND status='SUBMITTED' RETURNING ${FILING_COLUMNS}`, [filingId, validatedAt, actorSubject]);
      if (filingResult.rows.length !== 1) { const e = new Error('Filing was not in SUBMITTED state'); e.code='FILING_STATE_CONFLICT'; throw e; }
      const taskResult = await client.query(`UPDATE workflow.workflow_tasks SET status='COMPLETED', completed_at=$3, completed_by_subject=$4 WHERE task_id=$1 AND filing_id=$2 AND task_type='REGISTRY_VALIDATE_FILING' AND status <> 'COMPLETED' RETURNING task_id`, [taskId, filingId, validatedAt, actorSubject]);
      if (taskResult.rows.length !== 1) { const e = new Error('Registry validation task was not active'); e.code='TASK_STATE_CONFLICT'; throw e; }
      await client.query('COMMIT');
      return mapFiling(filingResult.rows[0]);
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  async transitionFiling({ filingId, fromStatuses, toStatus, actorSubject, reason, at }) {
    const result = await this.db.query(`UPDATE registry.filings SET status=$3, decision_reason=$4, decision_by_subject=$5, decision_at=$6 WHERE filing_id=$1 AND status = ANY($2::varchar[]) RETURNING ${FILING_COLUMNS}`, [filingId, fromStatuses, toStatus, reason || null, actorSubject, at]);
    if (result.rows.length !== 1) { const e = new Error(`Filing cannot transition to ${toStatus}`); e.code='FILING_STATE_CONFLICT'; throw e; }
    return mapFiling(result.rows[0]);
  }
  async createFeeAssessment({ assessmentId, filingId, courtId, amountMinor, currency, actorSubject, at }) {
    const result = await this.db.query(`INSERT INTO finance.fee_assessments (assessment_id,filing_id,court_id,amount_minor,currency,status,assessed_by_subject,assessed_at) VALUES ($1,$2,$3,$4,$5,'ASSESSED',$6,$7) RETURNING assessment_id,filing_id,court_id,amount_minor,currency,status,assessed_by_subject,assessed_at`, [assessmentId,filingId,courtId,amountMinor,currency,actorSubject,at]);
    const row=result.rows[0];
    return Object.freeze({ assessmentId:row.assessment_id, filingId:row.filing_id, courtId:row.court_id, amountMinor:Number(row.amount_minor), currency:row.currency, status:row.status, assessedBy:row.assessed_by_subject, assessedAt:row.assessed_at });
  }
  async getFeeAssessment(assessmentId) {
    const result=await this.db.query(`SELECT assessment_id,filing_id,court_id,amount_minor,currency,status,assessed_by_subject,assessed_at FROM finance.fee_assessments WHERE assessment_id=$1`,[assessmentId]);
    const row=result.rows[0];
    return row ? Object.freeze({ assessmentId:row.assessment_id, filingId:row.filing_id, courtId:row.court_id, amountMinor:Number(row.amount_minor), currency:row.currency, status:row.status, assessedBy:row.assessed_by_subject, assessedAt:row.assessed_at }) : null;
  }
  async createPayment({ paymentId, assessmentId, courtId, amountMinor, currency, actorSubject, at }) {
    const result=await this.db.query(`INSERT INTO finance.payments (payment_id,assessment_id,court_id,amount_minor,currency,status,created_by_subject,created_at) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7) RETURNING payment_id,assessment_id,court_id,amount_minor,currency,status,provider_reference,created_by_subject,created_at,confirmed_by_subject,confirmed_at`,[paymentId,assessmentId,courtId,amountMinor,currency,actorSubject,at]);
    const row=result.rows[0];
    return Object.freeze({ paymentId:row.payment_id, assessmentId:row.assessment_id, courtId:row.court_id, amountMinor:Number(row.amount_minor), currency:row.currency, status:row.status, providerReference:row.provider_reference||null, createdBy:row.created_by_subject, createdAt:row.created_at, confirmedBy:row.confirmed_by_subject||null, confirmedAt:row.confirmed_at||null });
  }
  async getPayment(paymentId) {
    const result=await this.db.query(`SELECT payment_id,assessment_id,court_id,amount_minor,currency,status,provider_reference,created_by_subject,created_at,confirmed_by_subject,confirmed_at FROM finance.payments WHERE payment_id=$1`,[paymentId]);
    const row=result.rows[0];
    return row ? Object.freeze({ paymentId:row.payment_id, assessmentId:row.assessment_id, courtId:row.court_id, amountMinor:Number(row.amount_minor), currency:row.currency, status:row.status, providerReference:row.provider_reference||null, createdBy:row.created_by_subject, createdAt:row.created_at, confirmedBy:row.confirmed_by_subject||null, confirmedAt:row.confirmed_at||null }) : null;
  }
  async confirmPayment({ paymentId, providerReference, actorSubject, at }) {
    const result=await this.db.query(`UPDATE finance.payments SET status='CONFIRMED',provider_reference=$2,confirmed_by_subject=$3,confirmed_at=$4 WHERE payment_id=$1 AND status='PENDING' RETURNING payment_id,assessment_id,court_id,amount_minor,currency,status,provider_reference,created_by_subject,created_at,confirmed_by_subject,confirmed_at`,[paymentId,providerReference,actorSubject,at]);
    if(result.rows.length!==1){ const e=new Error('Payment was not PENDING'); e.code='PAYMENT_STATE_CONFLICT'; throw e; }
    const row=result.rows[0];
    return Object.freeze({ paymentId:row.payment_id, assessmentId:row.assessment_id, courtId:row.court_id, amountMinor:Number(row.amount_minor), currency:row.currency, status:row.status, providerReference:row.provider_reference, createdBy:row.created_by_subject, createdAt:row.created_at, confirmedBy:row.confirmed_by_subject, confirmedAt:row.confirmed_at });
  }
  async createReceipt({ receiptId, receiptNumber, paymentId, courtId, amountMinor, currency, actorSubject, at }) {
    const result=await this.db.query(`INSERT INTO finance.receipts (receipt_id,receipt_number,payment_id,court_id,amount_minor,currency,status,issued_by_subject,issued_at) VALUES ($1,$2,$3,$4,$5,$6,'ISSUED',$7,$8) RETURNING receipt_id,receipt_number,payment_id,court_id,amount_minor,currency,status,issued_by_subject,issued_at`,[receiptId,receiptNumber,paymentId,courtId,amountMinor,currency,actorSubject,at]);
    return mapReceipt(result.rows[0]);
  }
  async getReceiptByPayment(paymentId) {
    const result=await this.db.query(`SELECT receipt_id,receipt_number,payment_id,court_id,amount_minor,currency,status,issued_by_subject,issued_at FROM finance.receipts WHERE payment_id=$1`,[paymentId]);
    return mapReceipt(result.rows[0]);
  }
  async createReconciliation({ reconciliationId, paymentId, courtId, actorSubject, at }) {
    const result=await this.db.query(`INSERT INTO finance.reconciliations (reconciliation_id,payment_id,court_id,status,prepared_by_subject,prepared_at) VALUES ($1,$2,$3,'PREPARED',$4,$5) RETURNING reconciliation_id,payment_id,court_id,status,prepared_by_subject,prepared_at,certified_by_subject,certified_at`,[reconciliationId,paymentId,courtId,actorSubject,at]);
    return mapReconciliation(result.rows[0]);
  }
  async getReconciliation(reconciliationId) {
    const result=await this.db.query(`SELECT reconciliation_id,payment_id,court_id,status,prepared_by_subject,prepared_at,certified_by_subject,certified_at FROM finance.reconciliations WHERE reconciliation_id=$1`,[reconciliationId]);
    return mapReconciliation(result.rows[0]);
  }
  async certifyReconciliation({ reconciliationId, actorSubject, at }) {
    const result=await this.db.query(`UPDATE finance.reconciliations SET status='CERTIFIED',certified_by_subject=$2,certified_at=$3 WHERE reconciliation_id=$1 AND status='PREPARED' AND prepared_by_subject <> $2 RETURNING reconciliation_id,payment_id,court_id,status,prepared_by_subject,prepared_at,certified_by_subject,certified_at`,[reconciliationId,actorSubject,at]);
    if(result.rows.length!==1){ const e=new Error('Reconciliation was not certifiable'); e.code='RECONCILIATION_STATE_CONFLICT'; throw e; }
    return mapReconciliation(result.rows[0]);
  }
  async getCaseByFiling(filingId) {
    const result=await this.db.query(`SELECT ${CASE_COLUMNS} FROM case_mgmt.cases WHERE filing_id=$1`,[filingId]);
    return mapCase(result.rows[0]);
  }
  async openCaseFromConfirmedPayment({ caseId, filingId, paymentId, courtId, caseTypeCode, actorSubject, openedAt }) {
    if (typeof this.db.connect !== 'function') throw new TypeError('openCaseFromConfirmedPayment requires a pool with connect()');
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      const existing=await client.query(`SELECT ${CASE_COLUMNS} FROM case_mgmt.cases WHERE filing_id=$1 FOR UPDATE`,[filingId]);
      if(existing.rows.length){ await client.query('COMMIT'); return mapCase(existing.rows[0]); }
      const court=await client.query(`SELECT court_code FROM config.courts WHERE court_id=$1`,[courtId]);
      if(court.rows.length!==1){ const e=new Error('Court configuration not found'); e.code='COURT_NOT_FOUND'; throw e; }
      const year=new Date(openedAt).getUTCFullYear();
      const sequence=await client.query(`INSERT INTO case_mgmt.case_number_sequences (court_id,case_type_code,case_year,last_value,updated_at) VALUES ($1,$2,$3,1,$4) ON CONFLICT (court_id,case_type_code,case_year) DO UPDATE SET last_value=case_mgmt.case_number_sequences.last_value+1,updated_at=EXCLUDED.updated_at RETURNING last_value`,[courtId,caseTypeCode,year,openedAt]);
      const number=String(sequence.rows[0].last_value).padStart(6,'0');
      const caseNumber=`${court.rows[0].court_code}-${caseTypeCode}-${year}-${number}`;
      const inserted=await client.query(`INSERT INTO case_mgmt.cases (case_id,case_number,filing_id,payment_id,court_id,case_type_code,status,opened_by_subject,opened_at) VALUES ($1,$2,$3,$4,$5,$6,'AWAITING_ASSIGNMENT',$7,$8) RETURNING ${CASE_COLUMNS}`,[caseId,caseNumber,filingId,paymentId,courtId,caseTypeCode,actorSubject,openedAt]);
      await client.query('COMMIT');
      return mapCase(inserted.rows[0]);
    } catch(error) { try{await client.query('ROLLBACK');}catch{} throw error; } finally { client.release(); }
  }
}

module.exports = { PostgresRepository, mapParty, mapTask, mapFiling, mapDocument, mapReceipt, mapReconciliation, mapCase };
