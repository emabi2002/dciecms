'use strict';
const { PostgresRepository } = require('./postgres-repository');

const JUDICIAL_CASE_COLUMNS = `case_id,case_number,filing_id,payment_id,court_id,case_type_code,status,opened_by_subject,opened_at,assigned_to_subject,assigned_by_subject,assigned_at`;
const HEARING_COLUMNS = `hearing_id,case_id,court_id,hearing_type,status,scheduled_start,scheduled_end,courtroom,scheduled_by_subject,created_at,adjourned_by_subject,adjourned_at,adjournment_reason,started_by_subject,started_at,completed_by_subject,completed_at,outcome_code`;

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

function mapHearing(row) {
  if (!row) return null;
  return Object.freeze({
    hearingId: row.hearing_id,
    caseId: row.case_id,
    courtId: row.court_id,
    hearingType: row.hearing_type,
    status: row.status,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    courtroom: row.courtroom || null,
    scheduledBy: row.scheduled_by_subject,
    createdAt: row.created_at,
    adjournedBy: row.adjourned_by_subject || null,
    adjournedAt: row.adjourned_at || null,
    adjournmentReason: row.adjournment_reason || null,
    startedBy: row.started_by_subject || null,
    startedAt: row.started_at || null,
    completedBy: row.completed_by_subject || null,
    completedAt: row.completed_at || null,
    outcomeCode: row.outcome_code || null
  });
}

function hearingStateConflict(message = 'Hearing state conflict') {
  const error = new Error(message);
  error.code = 'HEARING_STATE_CONFLICT';
  return error;
}

class JudicialPostgresRepository extends PostgresRepository {
  async getCase(caseId) {
    const result = await this.db.query(`SELECT ${JUDICIAL_CASE_COLUMNS} FROM case_mgmt.cases WHERE case_id=$1`, [caseId]);
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
       SET status='ASSIGNED',assigned_to_subject=$2,assigned_by_subject=$3,assigned_at=$4
       WHERE case_id=$1 AND status = ANY($5::varchar[]) AND assigned_to_subject IS NULL
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
       WHERE court_id = ANY($1::uuid[]) AND assigned_to_subject=$2
       ORDER BY assigned_at ASC, opened_at ASC`,
      [courtIds, assigneeSubject]
    );
    return result.rows.map(mapJudicialCase);
  }

  async createHearing({ hearingId, caseId, courtId, hearingType, scheduledStart, scheduledEnd, courtroom, actorSubject, createdAt }) {
    const result = await this.db.query(
      `INSERT INTO judicial.hearings
       (hearing_id,case_id,court_id,hearing_type,status,scheduled_start,scheduled_end,courtroom,scheduled_by_subject,created_at)
       VALUES ($1,$2,$3,$4,'SCHEDULED',$5,$6,$7,$8,$9)
       RETURNING ${HEARING_COLUMNS}`,
      [hearingId, caseId, courtId, hearingType, scheduledStart, scheduledEnd, courtroom || null, actorSubject, createdAt]
    );
    return mapHearing(result.rows[0]);
  }

  async getHearing(hearingId) {
    const result = await this.db.query(`SELECT ${HEARING_COLUMNS} FROM judicial.hearings WHERE hearing_id=$1`, [hearingId]);
    return mapHearing(result.rows[0]);
  }

  async adjournHearing({ hearingId, reason, nextStart, nextEnd, nextHearingId, actorSubject, at }) {
    if (typeof this.db.connect !== 'function') throw new TypeError('adjournHearing requires a pool with connect()');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT ${HEARING_COLUMNS} FROM judicial.hearings WHERE hearing_id=$1 FOR UPDATE`, [hearingId]);
      const current = locked.rows[0];
      if (!current || !['SCHEDULED', 'IN_PROGRESS'].includes(current.status)) throw hearingStateConflict();

      let nextHearing = null;
      if (nextStart && nextEnd && nextHearingId) {
        const nextResult = await client.query(
          `INSERT INTO judicial.hearings
           (hearing_id,case_id,court_id,hearing_type,status,scheduled_start,scheduled_end,courtroom,scheduled_by_subject,created_at)
           VALUES ($1,$2,$3,$4,'SCHEDULED',$5,$6,$7,$8,$9)
           RETURNING ${HEARING_COLUMNS}`,
          [nextHearingId, current.case_id, current.court_id, current.hearing_type, nextStart, nextEnd, current.courtroom || null, actorSubject, at]
        );
        nextHearing = mapHearing(nextResult.rows[0]);
      }

      await client.query(
        `INSERT INTO judicial.hearing_adjournments
         (hearing_id,case_id,court_id,prior_scheduled_start,prior_scheduled_end,reason,next_hearing_id,next_scheduled_start,next_scheduled_end,adjourned_by_subject,adjourned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [hearingId, current.case_id, current.court_id, current.scheduled_start, current.scheduled_end, reason, nextHearingId || null, nextStart || null, nextEnd || null, actorSubject, at]
      );

      const updated = await client.query(
        `UPDATE judicial.hearings
         SET status='ADJOURNED',adjournment_reason=$2,adjourned_by_subject=$3,adjourned_at=$4
         WHERE hearing_id=$1 AND status = ANY($5::varchar[])
         RETURNING ${HEARING_COLUMNS}`,
        [hearingId, reason, actorSubject, at, ['SCHEDULED', 'IN_PROGRESS']]
      );
      if (updated.rows.length !== 1) throw hearingStateConflict();
      await client.query('COMMIT');
      return Object.freeze({ ...mapHearing(updated.rows[0]), nextHearing });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async listDailyHearings({ courtIds, date }) {
    const result = await this.db.query(
      `SELECT ${HEARING_COLUMNS}
       FROM judicial.hearings
       WHERE court_id = ANY($1::uuid[])
         AND status <> 'CANCELLED'
         AND scheduled_start >= ($2::date AT TIME ZONE 'Pacific/Port_Moresby')
         AND scheduled_start < (($2::date + 1) AT TIME ZONE 'Pacific/Port_Moresby')
       ORDER BY scheduled_start ASC, courtroom ASC NULLS LAST`,
      [courtIds, date]
    );
    return result.rows.map(mapHearing);
  }

  async startHearing({ hearingId, actorSubject, at }) {
    const result = await this.db.query(
      `UPDATE judicial.hearings
       SET status='IN_PROGRESS',started_by_subject=$2,started_at=$3
       WHERE hearing_id=$1 AND status='SCHEDULED'
       RETURNING ${HEARING_COLUMNS}`,
      [hearingId, actorSubject, at]
    );
    if (result.rows.length !== 1) throw hearingStateConflict();
    return mapHearing(result.rows[0]);
  }

  async recordAppearance({ appearanceId, hearingId, participantName, participantRole, appearanceMode, actorSubject, at }) {
    const result = await this.db.query(
      `INSERT INTO judicial.hearing_appearances
       (appearance_id,hearing_id,case_id,court_id,participant_name,participant_role,appearance_mode,recorded_by_subject,recorded_at)
       SELECT $1,h.hearing_id,h.case_id,h.court_id,$3,$4,$5,$6,$7
       FROM judicial.hearings h
       WHERE h.hearing_id=$2 AND h.status='IN_PROGRESS'
       RETURNING appearance_id,hearing_id,case_id,court_id,participant_name,participant_role,appearance_mode,recorded_by_subject,recorded_at`,
      [appearanceId, hearingId, participantName, participantRole, appearanceMode, actorSubject, at]
    );
    if (result.rows.length !== 1) throw hearingStateConflict('Hearing must be in progress');
    const row = result.rows[0];
    return Object.freeze({
      appearanceId: row.appearance_id,
      hearingId: row.hearing_id,
      caseId: row.case_id,
      courtId: row.court_id,
      participantName: row.participant_name,
      participantRole: row.participant_role,
      appearanceMode: row.appearance_mode,
      recordedBy: row.recorded_by_subject,
      recordedAt: row.recorded_at
    });
  }

  async recordProceeding({ proceedingId, hearingId, note, recordReference, actorSubject, at }) {
    const result = await this.db.query(
      `INSERT INTO judicial.proceeding_records
       (proceeding_id,hearing_id,case_id,court_id,note,record_reference,recorded_by_subject,recorded_at)
       SELECT $1,h.hearing_id,h.case_id,h.court_id,$3,$4,$5,$6
       FROM judicial.hearings h
       WHERE h.hearing_id=$2 AND h.status='IN_PROGRESS'
       RETURNING proceeding_id,hearing_id,case_id,court_id,note,record_reference,recorded_by_subject,recorded_at`,
      [proceedingId, hearingId, note || null, recordReference || null, actorSubject, at]
    );
    if (result.rows.length !== 1) throw hearingStateConflict('Hearing must be in progress');
    const row = result.rows[0];
    return Object.freeze({
      proceedingId: row.proceeding_id,
      hearingId: row.hearing_id,
      caseId: row.case_id,
      courtId: row.court_id,
      note: row.note || null,
      recordReference: row.record_reference || null,
      recordedBy: row.recorded_by_subject,
      recordedAt: row.recorded_at
    });
  }

  async completeHearing({ hearingId, outcomeCode, actorSubject, at }) {
    const result = await this.db.query(
      `UPDATE judicial.hearings
       SET status='COMPLETED',outcome_code=$2,completed_by_subject=$3,completed_at=$4
       WHERE hearing_id=$1 AND status='IN_PROGRESS'
       RETURNING ${HEARING_COLUMNS}`,
      [hearingId, outcomeCode, actorSubject, at]
    );
    if (result.rows.length !== 1) throw hearingStateConflict();
    return mapHearing(result.rows[0]);
  }
}

module.exports = { JudicialPostgresRepository, mapJudicialCase, mapHearing };
