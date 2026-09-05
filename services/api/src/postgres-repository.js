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
  return Object.freeze({
    filingId: row.filing_id,
    filingReference: row.filing_reference,
    courtId: row.court_id,
    caseTypeCode: row.case_type_code,
    filerPartyId: row.filer_party_id,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    submittedAt: row.submitted_at || null,
    validatedAt: row.validated_at || null,
    validatedBy: row.validated_by_subject || null,
    decisionReason: row.decision_reason || null,
    decisionBy: row.decision_by_subject || null,
    decisionAt: row.decision_at || null
  });
}

const FILING_COLUMNS = `filing_id, filing_reference, court_id, case_type_code,
  filer_party_id, status, created_by, created_at, submitted_at,
  validated_at, validated_by_subject, decision_reason, decision_by_subject, decision_at`;

class PostgresRepository {
  constructor(queryable) {
    if (!queryable || (typeof queryable.query !== 'function' && typeof queryable.connect !== 'function')) throw new TypeError('PostgresRepository requires a pg-compatible queryable or pool');
    this.db = queryable;
  }

  async createParty({ partyId, courtId, partyType, displayName }) {
    const result = await this.db.query(`INSERT INTO case_mgmt.parties (party_id, court_id, party_type, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING party_id, court_id, party_type, display_name, created_at`, [partyId, courtId, partyType, displayName]);
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
    const result = await this.db.query(`INSERT INTO registry.filings (filing_id, filing_reference, court_id, case_type_code, filer_party_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${FILING_COLUMNS}`, [filingId, filingReference, courtId, caseTypeCode, filerPartyId, createdBy]);
    return mapFiling(result.rows[0]);
  }

  async getFiling(filingId) {
    const result = await this.db.query(`SELECT ${FILING_COLUMNS} FROM registry.filings WHERE filing_id = $1`, [filingId]);
    return mapFiling(result.rows[0]);
  }

  async createRegistryValidationTask({ taskId, filingId, courtId }) {
    const result = await this.db.query(`INSERT INTO workflow.workflow_tasks (task_id, filing_id, court_id, task_type, assigned_role_code, status)
       VALUES ($1, $2, $3, 'REGISTRY_VALIDATE_FILING', 'REG', 'PENDING')
       RETURNING task_id, filing_id, court_id, task_type, assigned_role_code, priority, status, due_at, created_at, completed_at, completed_by_subject`, [taskId, filingId, courtId]);
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
      await client.query(`INSERT INTO workflow.workflow_tasks (task_id, filing_id, court_id, task_type, assigned_role_code, status)
        VALUES ($1,$2,$3,'REGISTRY_VALIDATE_FILING','REG','PENDING')`, [taskId, filingId, filing.court_id]);
      await client.query('COMMIT');
      return mapFiling(filing);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async listWorkflowTasks({ courtIds, includeCompleted = false }) {
    const statusFilter = includeCompleted ? '' : "AND status <> 'COMPLETED'";
    const result = await this.db.query(`SELECT task_id, filing_id, court_id, task_type, assigned_role_code,
      priority, status, due_at, created_at, completed_at, completed_by_subject FROM workflow.workflow_tasks
      WHERE court_id = ANY($1::uuid[]) ${statusFilter} ORDER BY created_at ASC`, [courtIds]);
    return result.rows.map(mapTask);
  }

  async findActiveRegistryValidationTask(filingId) {
    const result = await this.db.query(`SELECT task_id, filing_id, court_id, task_type, assigned_role_code,
      priority, status, due_at, created_at, completed_at, completed_by_subject FROM workflow.workflow_tasks
      WHERE filing_id=$1 AND task_type = 'REGISTRY_VALIDATE_FILING' AND status NOT IN ('COMPLETED','CANCELLED') ORDER BY created_at ASC LIMIT 1`, [filingId]);
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
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async transitionFiling({ filingId, fromStatuses, toStatus, actorSubject, reason, at }) {
    const result = await this.db.query(`UPDATE registry.filings SET status=$3, decision_reason=$4, decision_by_subject=$5, decision_at=$6 WHERE filing_id=$1 AND status = ANY($2::varchar[]) RETURNING ${FILING_COLUMNS}`,
      [filingId, fromStatuses, toStatus, reason || null, actorSubject, at]);
    if (result.rows.length !== 1) { const e = new Error(`Filing cannot transition to ${toStatus}`); e.code='FILING_STATE_CONFLICT'; throw e; }
    return mapFiling(result.rows[0]);
  }
}

module.exports = { PostgresRepository, mapParty, mapTask, mapFiling };
