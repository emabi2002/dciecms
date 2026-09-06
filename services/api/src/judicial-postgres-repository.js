'use strict';
const { PostgresRepository } = require('./postgres-repository');

const JUDICIAL_CASE_COLUMNS = `case_id,case_number,filing_id,payment_id,court_id,case_type_code,status,opened_by_subject,opened_at,assigned_to_subject,assigned_by_subject,assigned_at`;

function mapJudicialCase(row) {
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
    assignedAt: row.assigned_at || null
  });
}

class JudicialPostgresRepository extends PostgresRepository {
  async getCase(caseId) {
    const result = await this.db.query(
      `SELECT ${JUDICIAL_CASE_COLUMNS} FROM case_mgmt.cases WHERE case_id=$1`,
      [caseId]
    );
    return mapJudicialCase(result.rows[0]);
  }

  async isActiveMagistrateInCourt(subject, courtId) {
    const result = await this.db.query(
      `SELECT true AS eligible
       FROM iam.users u
       JOIN iam.user_role_assignments ura ON ura.user_id=u.user_id
       JOIN iam.roles r ON r.role_id=ura.role_id
       WHERE u.identity_provider_subject=$1
         AND u.status='ACTIVE'
         AND ura.court_id=$2
         AND ura.status='ACTIVE'
         AND ura.effective_from <= now()
         AND (ura.effective_to IS NULL OR ura.effective_to > now())
         AND r.role_code='MAG'
         AND r.status='ACTIVE'
       LIMIT 1`,
      [subject, courtId]
    );
    return result.rows.length === 1;
  }

  async assignCase({ caseId, assigneeSubject, actorSubject, assignedAt }) {
    const result = await this.db.query(
      `UPDATE case_mgmt.cases
       SET status='ASSIGNED',
           assigned_to_subject=$2,
           assigned_by_subject=$3,
           assigned_at=$4
       WHERE case_id=$1
         AND status = ANY($5::varchar[])
         AND assigned_to_subject IS NULL
       RETURNING ${JUDICIAL_CASE_COLUMNS}`,
      [caseId, assigneeSubject, actorSubject, assignedAt, ['OPEN', 'AWAITING_ASSIGNMENT']]
    );
    if (result.rows.length !== 1) {
      const error = new Error('Case assignment state conflict');
      error.code = 'CASE_ASSIGNMENT_CONFLICT';
      throw error;
    }
    return mapJudicialCase(result.rows[0]);
  }

  async listAssignedCases({ courtIds, assigneeSubject }) {
    const result = await this.db.query(
      `SELECT ${JUDICIAL_CASE_COLUMNS}
       FROM case_mgmt.cases
       WHERE court_id = ANY($1::uuid[])
         AND assigned_to_subject=$2
       ORDER BY assigned_at ASC, opened_at ASC`,
      [courtIds, assigneeSubject]
    );
    return result.rows.map(mapJudicialCase);
  }
}

module.exports = { JudicialPostgresRepository, mapJudicialCase };
