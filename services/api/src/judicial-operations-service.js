'use strict';
const { randomUUID } = require('node:crypto');
const { authorize, AccessDeniedError } = require('../../../packages/rbac');
const { ConflictError, NotFoundError, ValidationError } = require('./dciecms-service');
const { PersistentDciecmsService } = require('./persistent-dciecms-service');

class JudicialOperationsService extends PersistentDciecmsService {
  async assignCase(actor, caseId, input) {
    const courtCase = await this.repository.getCase(caseId);
    if (!courtCase) throw new NotFoundError('Case not found');
    authorize(actor, 'case.assign', { courtId: courtCase.courtId });

    const assigneeSubject = String(input?.assigneeSubject || '').trim();
    if (!assigneeSubject) throw new ValidationError('assigneeSubject is required');
    if (!['OPEN', 'AWAITING_ASSIGNMENT'].includes(courtCase.status)) {
      throw new ConflictError(`Case cannot be assigned from status ${courtCase.status}`);
    }

    const eligible = await this.repository.isActiveMagistrateInCourt(assigneeSubject, courtCase.courtId);
    if (!eligible) throw new ValidationError('Assignee is not an active magistrate in the case court');

    try {
      const assigned = await this.repository.assignCase({
        caseId,
        assigneeSubject,
        actorSubject: actor.userId,
        assignedAt: new Date().toISOString()
      });
      this._audit(actor, 'case.assign', 'case', caseId, {
        courtId: courtCase.courtId,
        assigneeSubject
      });
      return assigned;
    } catch (error) {
      if (error.code === 'CASE_ASSIGNMENT_CONFLICT') throw new ConflictError('Case assignment conflict');
      throw error;
    }
  }

  async listMyCases(actor) {
    authorize(actor, 'case.view', {});
    const rows = await this.repository.listAssignedCases({ courtIds: actor.courtIds, assigneeSubject: actor.userId });
    this._audit(actor, 'judicial.my_cases.view', 'case_queue', actor.userId, { courtIds: actor.courtIds });
    return rows;
  }

  _requireJudicialCaseAccess(actor, courtCase, permission) {
    authorize(actor, permission, { courtId: courtCase.courtId });
    if (actor.roles.includes('MAG') && !actor.roles.includes('CMAG') && courtCase.assignedToSubject !== actor.userId) {
      throw new AccessDeniedError('Case is not assigned to this magistrate');
    }
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
    if (!['ASSIGNED', 'HEARING_SCHEDULED'].includes(courtCase.status)) {
      throw new ConflictError(`Case cannot schedule a hearing from status ${courtCase.status}`);
    }

    const hearingType = String(input?.hearingType || '').trim().toUpperCase();
    const scheduledStart = String(input?.scheduledStart || '').trim();
    const scheduledEnd = String(input?.scheduledEnd || '').trim();
    if (!hearingType || !scheduledStart || !scheduledEnd) throw new ValidationError('hearingType, scheduledStart and scheduledEnd are required');
    const startMs = Date.parse(scheduledStart);
    const endMs = Date.parse(scheduledEnd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new ValidationError('Hearing schedule is invalid');

    const hearing = await this.repository.createHearing({
      hearingId: randomUUID(), caseId, courtId: courtCase.courtId, hearingType,
      scheduledStart: new Date(startMs).toISOString(), scheduledEnd: new Date(endMs).toISOString(),
      courtroom: input?.courtroom ? String(input.courtroom).trim() : null,
      actorSubject: actor.userId, createdAt: new Date().toISOString()
    });
    this._audit(actor, 'hearing.schedule', 'hearing', hearing.hearingId, { courtId: courtCase.courtId, caseId });
    return hearing;
  }

  async adjournHearing(actor, hearingId, input) {
    const { hearing } = await this._hearingContext(actor, hearingId, 'hearing.adjourn');
    const reason = String(input?.reason || '').trim();
    if (!reason) throw new ValidationError('Adjournment reason is required');
    const nextStart = input?.nextStart ? new Date(Date.parse(input.nextStart)).toISOString() : null;
    const nextEnd = input?.nextEnd ? new Date(Date.parse(input.nextEnd)).toISOString() : null;
    if ((nextStart && !nextEnd) || (!nextStart && nextEnd) || (nextStart && Date.parse(nextEnd) <= Date.parse(nextStart))) {
      throw new ValidationError('Next hearing schedule is invalid');
    }
    try {
      const adjourned = await this.repository.adjournHearing({
        hearingId, reason, nextStart, nextEnd, nextHearingId: nextStart ? randomUUID() : null,
        actorSubject: actor.userId, at: new Date().toISOString()
      });
      this._audit(actor, 'hearing.adjourn', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId, reason });
      return adjourned;
    } catch (error) {
      if (error.code === 'HEARING_STATE_CONFLICT') throw new ConflictError('Hearing state conflict');
      throw error;
    }
  }

  async listDailyHearings(actor, input) {
    authorize(actor, 'hearing.view', {});
    const date = String(input?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('date must be YYYY-MM-DD');
    const rows = await this.repository.listDailyHearings({ courtIds: actor.courtIds, date });
    this._audit(actor, 'hearing.daily_list.view', 'hearing_queue', date, { courtIds: actor.courtIds });
    return rows;
  }

  async startHearing(actor, hearingId) {
    const { hearing } = await this._hearingContext(actor, hearingId, 'hearing.start');
    if (hearing.status !== 'SCHEDULED') throw new ConflictError(`Hearing cannot start from status ${hearing.status}`);
    try {
      const started = await this.repository.startHearing({ hearingId, actorSubject: actor.userId, at: new Date().toISOString() });
      this._audit(actor, 'hearing.start', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId });
      return started;
    } catch (error) {
      if (error.code === 'HEARING_STATE_CONFLICT') throw new ConflictError('Hearing state conflict');
      throw error;
    }
  }

  async recordAppearance(actor, hearingId, input) {
    const { hearing } = await this._hearingContext(actor, hearingId, 'proceeding.record');
    const participantName = String(input?.participantName || '').trim();
    const participantRole = String(input?.participantRole || '').trim().toUpperCase();
    const appearanceMode = String(input?.appearanceMode || '').trim().toUpperCase();
    if (!participantName || !participantRole || !appearanceMode) throw new ValidationError('participantName, participantRole and appearanceMode are required');
    try {
      const appearance = await this.repository.recordAppearance({
        appearanceId: randomUUID(), hearingId, participantName, participantRole, appearanceMode,
        actorSubject: actor.userId, at: new Date().toISOString()
      });
      this._audit(actor, 'hearing.appearance.record', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId, appearanceId: appearance.appearanceId });
      return appearance;
    } catch (error) {
      if (error.code === 'HEARING_STATE_CONFLICT') throw new ConflictError('Hearing must be in progress');
      throw error;
    }
  }

  async recordProceeding(actor, hearingId, input) {
    const { hearing } = await this._hearingContext(actor, hearingId, 'proceeding.record');
    const note = input?.note ? String(input.note).trim() : null;
    const recordReference = input?.recordReference ? String(input.recordReference).trim() : null;
    if (!note && !recordReference) throw new ValidationError('A proceeding note or record reference is required');
    try {
      const proceeding = await this.repository.recordProceeding({
        proceedingId: randomUUID(), hearingId, note, recordReference,
        actorSubject: actor.userId, at: new Date().toISOString()
      });
      this._audit(actor, 'hearing.proceeding.record', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId, proceedingId: proceeding.proceedingId });
      return proceeding;
    } catch (error) {
      if (error.code === 'HEARING_STATE_CONFLICT') throw new ConflictError('Hearing must be in progress');
      throw error;
    }
  }

  async completeHearing(actor, hearingId, input) {
    const { hearing } = await this._hearingContext(actor, hearingId, 'hearing.complete');
    const outcomeCode = String(input?.outcomeCode || '').trim().toUpperCase();
    if (!outcomeCode) throw new ValidationError('outcomeCode is required');
    if (hearing.status !== 'IN_PROGRESS') throw new ConflictError(`Hearing cannot complete from status ${hearing.status}`);
    try {
      const completed = await this.repository.completeHearing({ hearingId, outcomeCode, actorSubject: actor.userId, at: new Date().toISOString() });
      this._audit(actor, 'hearing.complete', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId, outcomeCode });
      return completed;
    } catch (error) {
      if (error.code === 'HEARING_STATE_CONFLICT') throw new ConflictError('Hearing state conflict');
      throw error;
    }
  }
}

module.exports = { JudicialOperationsService };
