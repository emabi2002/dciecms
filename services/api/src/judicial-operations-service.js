'use strict';
const { randomUUID } = require('node:crypto');
const { authorize, AccessDeniedError } = require('../../../packages/rbac');
const { ConflictError, NotFoundError, ValidationError } = require('./dciecms-service');
const { PersistentDciecmsService } = require('./persistent-dciecms-service');

function isIsoCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

class JudicialOperationsService extends PersistentDciecmsService {
  _stateConflict(error, code, message) {
    if (error.code === code) throw new ConflictError(message);
    throw error;
  }

  async assignCase(actor, caseId, input) {
    const courtCase = await this.repository.getCase(caseId);
    if (!courtCase) throw new NotFoundError('Case not found');
    authorize(actor, 'case.assign', { courtId: courtCase.courtId });
    const assigneeSubject = String(input?.assigneeSubject || '').trim();
    if (!assigneeSubject) throw new ValidationError('assigneeSubject is required');
    if (!['OPEN', 'AWAITING_ASSIGNMENT'].includes(courtCase.status)) throw new ConflictError(`Case cannot be assigned from status ${courtCase.status}`);
    if (!await this.repository.isActiveMagistrateInCourt(assigneeSubject, courtCase.courtId)) throw new ValidationError('Assignee is not an active magistrate in the case court');
    try {
      const assigned = await this.repository.assignCase({ caseId, assigneeSubject, actorSubject: actor.userId, assignedAt: new Date().toISOString() });
      await this._audit(actor, 'case.assign', 'case', caseId, { courtId: courtCase.courtId, assigneeSubject });
      return assigned;
    } catch (error) { return this._stateConflict(error, 'CASE_ASSIGNMENT_CONFLICT', 'Case assignment conflict'); }
  }

  async listMyCases(actor) {
    authorize(actor, 'case.view', {});
    const rows = await this.repository.listAssignedCases({ courtIds: actor.courtIds, assigneeSubject: actor.userId });
    await this._audit(actor, 'judicial.my_cases.view', 'case_queue', actor.userId, { courtIds: actor.courtIds });
    return rows;
  }

  _requireJudicialCaseAccess(actor, courtCase, permission) {
    authorize(actor, permission, { courtId: courtCase.courtId });
    if (actor.roles.includes('MAG') && !actor.roles.includes('CMAG') && courtCase.assignedToSubject !== actor.userId) throw new AccessDeniedError('Case is not assigned to this magistrate');
  }

  async _hearingContext(actor, hearingId, permission) {
    const hearing = await this.repository.getHearing(hearingId);
    if (!hearing) throw new NotFoundError('Hearing not found');
    const courtCase = await this.repository.getCase(hearing.caseId);
    if (!courtCase) throw new NotFoundError('Case not found');
    this._requireJudicialCaseAccess(actor, courtCase, permission);
    return { hearing, courtCase };
  }

  async scheduleHearing(actor, caseId, input) {
    const courtCase = await this.repository.getCase(caseId);
    if (!courtCase) throw new NotFoundError('Case not found');
    this._requireJudicialCaseAccess(actor, courtCase, 'hearing.schedule');
    if (!['ASSIGNED', 'HEARING_SCHEDULED'].includes(courtCase.status)) throw new ConflictError(`Case cannot schedule a hearing from status ${courtCase.status}`);
    const hearingType = String(input?.hearingType || '').trim().toUpperCase();
    const scheduledStart = String(input?.scheduledStart || '').trim();
    const scheduledEnd = String(input?.scheduledEnd || '').trim();
    if (!hearingType || !scheduledStart || !scheduledEnd) throw new ValidationError('hearingType, scheduledStart and scheduledEnd are required');
    const startMs = Date.parse(scheduledStart), endMs = Date.parse(scheduledEnd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new ValidationError('Hearing schedule is invalid');
    const hearing = await this.repository.createHearing({ hearingId: randomUUID(), caseId, courtId: courtCase.courtId, hearingType, scheduledStart: new Date(startMs).toISOString(), scheduledEnd: new Date(endMs).toISOString(), courtroom: input?.courtroom ? String(input.courtroom).trim() : null, actorSubject: actor.userId, createdAt: new Date().toISOString() });
    await this._audit(actor, 'hearing.schedule', 'hearing', hearing.hearingId, { courtId: courtCase.courtId, caseId });
    await this._emitDomainEvent(actor, 'hearing.scheduled', 'hearing', hearing.hearingId, {
      courtId: courtCase.courtId,
      payload: { hearingId: hearing.hearingId, caseId, courtId: courtCase.courtId, status: hearing.status, hearingType: hearing.hearingType, scheduledStart: hearing.scheduledStart, scheduledEnd: hearing.scheduledEnd }
    });
    return hearing;
  }

  async adjournHearing(actor, hearingId, input) {
    const { hearing } = await this._hearingContext(actor, hearingId, 'hearing.adjourn');
    const reason = String(input?.reason || '').trim();
    if (!reason) throw new ValidationError('Adjournment reason is required');
    const rawNextStart = input?.nextStart ? String(input.nextStart).trim() : '';
    const rawNextEnd = input?.nextEnd ? String(input.nextEnd).trim() : '';
    const nextStartMs = rawNextStart ? Date.parse(rawNextStart) : null;
    const nextEndMs = rawNextEnd ? Date.parse(rawNextEnd) : null;
    if ((rawNextStart && !rawNextEnd) || (!rawNextStart && rawNextEnd) ||
        (rawNextStart && (!Number.isFinite(nextStartMs) || !Number.isFinite(nextEndMs) || nextEndMs <= nextStartMs))) {
      throw new ValidationError('Next hearing schedule is invalid');
    }
    const nextStart = rawNextStart ? new Date(nextStartMs).toISOString() : null;
    const nextEnd = rawNextEnd ? new Date(nextEndMs).toISOString() : null;
    try {
      const adjourned = await this.repository.adjournHearing({ hearingId, reason, nextStart, nextEnd, nextHearingId: nextStart ? randomUUID() : null, actorSubject: actor.userId, at: new Date().toISOString() });
      await this._audit(actor, 'hearing.adjourn', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId, reason });
      await this._emitDomainEvent(actor, 'hearing.adjourned', 'hearing', hearingId, {
        courtId: hearing.courtId,
        payload: { hearingId, caseId: hearing.caseId, courtId: hearing.courtId, status: adjourned.status, reason, nextStart, nextEnd }
      });
      return adjourned;
    } catch (error) { return this._stateConflict(error, 'HEARING_STATE_CONFLICT', 'Hearing state conflict'); }
  }

  async listDailyHearings(actor, input) {
    authorize(actor, 'hearing.view', {});
    const date = String(input?.date || '').trim();
    if (!isIsoCalendarDate(date)) throw new ValidationError('date must be a valid YYYY-MM-DD calendar date');
    const rows = await this.repository.listDailyHearings({ courtIds: actor.courtIds, date });
    await this._audit(actor, 'hearing.daily_list.view', 'hearing_queue', date, { courtIds: actor.courtIds });
    return rows;
  }

  async startHearing(actor, hearingId) {
    const { hearing } = await this._hearingContext(actor, hearingId, 'hearing.start');
    if (hearing.status !== 'SCHEDULED') throw new ConflictError(`Hearing cannot start from status ${hearing.status}`);
    try {
      const started = await this.repository.startHearing({ hearingId, actorSubject: actor.userId, at: new Date().toISOString() });
      await this._audit(actor, 'hearing.start', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId });
      return started;
    } catch (error) { return this._stateConflict(error, 'HEARING_STATE_CONFLICT', 'Hearing state conflict'); }
  }

  async recordAppearance(actor, hearingId, input) {
    const { hearing } = await this._hearingContext(actor, hearingId, 'proceeding.record');
    const participantName = String(input?.participantName || '').trim(), participantRole = String(input?.participantRole || '').trim().toUpperCase(), appearanceMode = String(input?.appearanceMode || '').trim().toUpperCase();
    if (!participantName || !participantRole || !appearanceMode) throw new ValidationError('participantName, participantRole and appearanceMode are required');
    try {
      const appearance = await this.repository.recordAppearance({ appearanceId: randomUUID(), hearingId, participantName, participantRole, appearanceMode, actorSubject: actor.userId, at: new Date().toISOString() });
      await this._audit(actor, 'hearing.appearance.record', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId, appearanceId: appearance.appearanceId });
      return appearance;
    } catch (error) { return this._stateConflict(error, 'HEARING_STATE_CONFLICT', 'Hearing must be in progress'); }
  }

  async recordProceeding(actor, hearingId, input) {
    const { hearing } = await this._hearingContext(actor, hearingId, 'proceeding.record');
    const note = input?.note ? String(input.note).trim() : null, recordReference = input?.recordReference ? String(input.recordReference).trim() : null;
    if (!note && !recordReference) throw new ValidationError('A proceeding note or record reference is required');
    try {
      const proceeding = await this.repository.recordProceeding({ proceedingId: randomUUID(), hearingId, note, recordReference, actorSubject: actor.userId, at: new Date().toISOString() });
      await this._audit(actor, 'hearing.proceeding.record', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId, proceedingId: proceeding.proceedingId });
      return proceeding;
    } catch (error) { return this._stateConflict(error, 'HEARING_STATE_CONFLICT', 'Hearing must be in progress'); }
  }

  async completeHearing(actor, hearingId, input) {
    const { hearing } = await this._hearingContext(actor, hearingId, 'hearing.complete');
    const outcomeCode = String(input?.outcomeCode || '').trim().toUpperCase();
    if (!outcomeCode) throw new ValidationError('outcomeCode is required');
    if (hearing.status !== 'IN_PROGRESS') throw new ConflictError(`Hearing cannot complete from status ${hearing.status}`);
    try {
      const completed = await this.repository.completeHearing({ hearingId, outcomeCode, actorSubject: actor.userId, at: new Date().toISOString() });
      await this._audit(actor, 'hearing.complete', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId, outcomeCode });
      await this._emitDomainEvent(actor, 'hearing.completed', 'hearing', hearingId, {
        courtId: hearing.courtId,
        payload: { hearingId, caseId: hearing.caseId, courtId: hearing.courtId, status: completed.status, outcomeCode }
      });
      return completed;
    } catch (error) { return this._stateConflict(error, 'HEARING_STATE_CONFLICT', 'Hearing state conflict'); }
  }

  async _judgmentContext(actor, judgmentId, permission) {
    const judgment = await this.repository.getJudgment(judgmentId);
    if (!judgment) throw new NotFoundError('Judgment not found');
    const courtCase = await this.repository.getCase(judgment.caseId);
    if (!courtCase) throw new NotFoundError('Case not found');
    this._requireJudicialCaseAccess(actor, courtCase, permission);
    return { judgment, courtCase };
  }

  async createJudgment(actor, caseId, input) {
    const courtCase = await this.repository.getCase(caseId);
    if (!courtCase) throw new NotFoundError('Case not found');
    this._requireJudicialCaseAccess(actor, courtCase, 'judgment.create');
    const hearingId = String(input?.hearingId || '').trim();
    const hearing = hearingId ? await this.repository.getHearing(hearingId) : null;
    if (!hearing || hearing.caseId !== caseId) throw new ValidationError('A completed hearing for this case is required');
    if (hearing.status !== 'COMPLETED') throw new ConflictError('Judgment requires a completed hearing');
    const decisionType = String(input?.decisionType || '').trim().toUpperCase(), title = String(input?.title || '').trim(), content = String(input?.content || '').trim();
    if (!decisionType || !title || !content) throw new ValidationError('decisionType, title and content are required');
    const row = await this.repository.createJudgment({ judgmentId: randomUUID(), caseId, hearingId, courtId: courtCase.courtId, decisionType, title, content, actorSubject: actor.userId, at: new Date().toISOString() });
    await this._audit(actor, 'judgment.create', 'judgment', row.judgmentId, { courtId: courtCase.courtId, caseId, hearingId });
    return row;
  }

  async updateJudgmentDraft(actor, judgmentId, input) {
    const { judgment } = await this._judgmentContext(actor, judgmentId, 'judgment.create');
    if (judgment.status !== 'DRAFT') throw new ConflictError('Only a draft judgment may be edited');
    const title = String(input?.title || '').trim(), content = String(input?.content || '').trim();
    if (!title || !content) throw new ValidationError('title and content are required');
    try {
      const row = await this.repository.updateJudgmentDraft({ judgmentId, title, content, actorSubject: actor.userId, at: new Date().toISOString() });
      await this._audit(actor, 'judgment.update', 'judgment', judgmentId, { courtId: judgment.courtId, caseId: judgment.caseId, version: row.version });
      return row;
    } catch (error) { return this._stateConflict(error, 'JUDGMENT_STATE_CONFLICT', 'Judgment is immutable in its current state'); }
  }

  async reviewJudgment(actor, judgmentId) {
    const { judgment } = await this._judgmentContext(actor, judgmentId, 'judgment.review');
    if (judgment.status !== 'DRAFT') throw new ConflictError('Judgment can be reviewed only from DRAFT');
    try {
      const row = await this.repository.reviewJudgment({ judgmentId, actorSubject: actor.userId, at: new Date().toISOString() });
      await this._audit(actor, 'judgment.review', 'judgment', judgmentId, { courtId: judgment.courtId, caseId: judgment.caseId });
      return row;
    } catch (error) { return this._stateConflict(error, 'JUDGMENT_STATE_CONFLICT', 'Judgment state conflict'); }
  }

  async signJudgment(actor, judgmentId) {
    const { judgment } = await this._judgmentContext(actor, judgmentId, 'judgment.sign');
    if (judgment.status !== 'FINAL') throw new ConflictError('Judgment must be FINAL before signing');
    try {
      const row = await this.repository.signJudgment({ judgmentId, actorSubject: actor.userId, at: new Date().toISOString() });
      await this._audit(actor, 'judgment.sign', 'judgment', judgmentId, { courtId: judgment.courtId, caseId: judgment.caseId });
      return row;
    } catch (error) { return this._stateConflict(error, 'JUDGMENT_STATE_CONFLICT', 'Judgment state conflict'); }
  }

  async issueJudgment(actor, judgmentId) {
    const { judgment } = await this._judgmentContext(actor, judgmentId, 'judgment.issue');
    if (judgment.status !== 'SIGNED') throw new ConflictError('Judgment must be SIGNED before issuance');
    try {
      const row = await this.repository.issueJudgment({ judgmentId, actorSubject: actor.userId, at: new Date().toISOString() });
      await this._audit(actor, 'judgment.issue', 'judgment', judgmentId, { courtId: judgment.courtId, caseId: judgment.caseId });
      await this._emitDomainEvent(actor, 'judgment.issued', 'judgment', judgmentId, {
        courtId: judgment.courtId,
        payload: { judgmentId, caseId: judgment.caseId, courtId: judgment.courtId, status: row.status }
      });
      return row;
    } catch (error) { return this._stateConflict(error, 'JUDGMENT_STATE_CONFLICT', 'Judgment state conflict'); }
  }
}

module.exports = { JudicialOperationsService };
