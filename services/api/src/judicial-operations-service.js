'use strict';
const { authorize } = require('../../../packages/rbac');
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
      if (error.code === 'CASE_ASSIGNMENT_CONFLICT') {
        throw new ConflictError('Case assignment conflict');
      }
      throw error;
    }
  }

  async listMyCases(actor) {
    authorize(actor, 'case.view', {});
    const rows = await this.repository.listAssignedCases({
      courtIds: actor.courtIds,
      assigneeSubject: actor.userId
    });
    this._audit(actor, 'judicial.my_cases.view', 'case_queue', actor.userId, {
      courtIds: actor.courtIds
    });
    return rows;
  }
}

module.exports = { JudicialOperationsService };
