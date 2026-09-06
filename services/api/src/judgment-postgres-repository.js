'use strict';
const { JudicialPostgresRepository } = require('./judicial-postgres-repository');

const JUDGMENT_COLUMNS = `judgment_id,case_id,hearing_id,court_id,decision_type,title,content,status,version,created_by_subject,created_at,updated_by_subject,updated_at,reviewed_by_subject,reviewed_at,signed_by_subject,signed_at,issued_by_subject,issued_at`;

function mapJudgment(row) {
  if (!row) return null;
  return Object.freeze({
    judgmentId: row.judgment_id,
    caseId: row.case_id,
    hearingId: row.hearing_id,
    courtId: row.court_id,
    decisionType: row.decision_type,
    title: row.title,
    content: row.content,
    status: row.status,
    version: Number(row.version),
    createdBy: row.created_by_subject,
    createdAt: row.created_at,
    updatedBy: row.updated_by_subject || null,
    updatedAt: row.updated_at || null,
    reviewedBy: row.reviewed_by_subject || null,
    reviewedAt: row.reviewed_at || null,
    signedBy: row.signed_by_subject || null,
    signedAt: row.signed_at || null,
    issuedBy: row.issued_by_subject || null,
    issuedAt: row.issued_at || null
  });
}

function conflict() {
  const error = new Error('Judgment state conflict');
  error.code = 'JUDGMENT_STATE_CONFLICT';
  return error;
}

class JudgmentPostgresRepository extends JudicialPostgresRepository {
  async createJudgment({ judgmentId, caseId, hearingId, courtId, decisionType, title, content, actorSubject, at }) {
    const result = await this.db.query(
      `INSERT INTO judicial.judgments
       (judgment_id,case_id,hearing_id,court_id,decision_type,title,content,status,version,created_by_subject,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',1,$8,$9)
       RETURNING ${JUDGMENT_COLUMNS}`,
      [judgmentId, caseId, hearingId, courtId, decisionType, title, content, actorSubject, at]
    );
    return mapJudgment(result.rows[0]);
  }

  async getJudgment(judgmentId) {
    const result = await this.db.query(`SELECT ${JUDGMENT_COLUMNS} FROM judicial.judgments WHERE judgment_id=$1`, [judgmentId]);
    return mapJudgment(result.rows[0]);
  }

  async updateJudgmentDraft({ judgmentId, title, content, actorSubject, at }) {
    const result = await this.db.query(
      `UPDATE judicial.judgments
       SET title=$2,content=$3,version=version+1,updated_at=$4,updated_by_subject=$5
       WHERE judgment_id=$1 AND status='DRAFT'
       RETURNING ${JUDGMENT_COLUMNS}`,
      [judgmentId, title, content, at, actorSubject]
    );
    if (result.rows.length !== 1) throw conflict();
    return mapJudgment(result.rows[0]);
  }

  async reviewJudgment({ judgmentId, actorSubject, at }) {
    const result = await this.db.query(
      `UPDATE judicial.judgments SET status='FINAL',reviewed_by_subject=$2,reviewed_at=$3
       WHERE judgment_id=$1 AND status='DRAFT'
       RETURNING ${JUDGMENT_COLUMNS}`,
      [judgmentId, actorSubject, at]
    );
    if (result.rows.length !== 1) throw conflict();
    return mapJudgment(result.rows[0]);
  }

  async signJudgment({ judgmentId, actorSubject, at }) {
    const result = await this.db.query(
      `UPDATE judicial.judgments SET status='SIGNED',signed_by_subject=$2,signed_at=$3
       WHERE judgment_id=$1 AND status='FINAL'
       RETURNING ${JUDGMENT_COLUMNS}`,
      [judgmentId, actorSubject, at]
    );
    if (result.rows.length !== 1) throw conflict();
    return mapJudgment(result.rows[0]);
  }

  async issueJudgment({ judgmentId, actorSubject, at }) {
    const result = await this.db.query(
      `UPDATE judicial.judgments SET status='ISSUED',issued_by_subject=$2,issued_at=$3
       WHERE judgment_id=$1 AND status='SIGNED'
       RETURNING ${JUDGMENT_COLUMNS}`,
      [judgmentId, actorSubject, at]
    );
    if (result.rows.length !== 1) throw conflict();
    return mapJudgment(result.rows[0]);
  }
}

module.exports = { JudgmentPostgresRepository, mapJudgment };
