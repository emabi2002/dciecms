'use strict';
const { authorize } = require('../../../packages/rbac');
const { NotFoundError } = require('./dciecms-service');
const { JudicialOperationsService } = require('./judicial-operations-service');

class JudicialWorkbenchService extends JudicialOperationsService {
  async getJudicialCase(actor, caseId) {
    const courtCase = await this.repository.getCase(caseId);
    if (!courtCase) throw new NotFoundError('Case not found');
    this._requireJudicialCaseAccess(actor, courtCase, 'case.view');
    this._audit(actor, 'judicial.case.view', 'case', caseId, { courtId: courtCase.courtId });
    return courtCase;
  }

  async getJudicialHearing(actor, hearingId) {
    const hearing = await this.repository.getHearing(hearingId);
    if (!hearing) throw new NotFoundError('Hearing not found');
    const courtCase = await this.repository.getCase(hearing.caseId);
    if (!courtCase) throw new NotFoundError('Case not found');
    this._requireJudicialCaseAccess(actor, courtCase, 'hearing.view');
    this._audit(actor, 'judicial.hearing.view', 'hearing', hearingId, { courtId: hearing.courtId, caseId: hearing.caseId });
    return hearing;
  }

  async getJudgment(actor, judgmentId) {
    const judgment = await this.repository.getJudgment(judgmentId);
    if (!judgment) throw new NotFoundError('Judgment not found');
    const courtCase = await this.repository.getCase(judgment.caseId);
    if (!courtCase) throw new NotFoundError('Case not found');
    this._requireJudicialCaseAccess(actor, courtCase, 'judgment.review');
    this._audit(actor, 'judicial.judgment.view', 'judgment', judgmentId, { courtId: judgment.courtId, caseId: judgment.caseId });
    return judgment;
  }

  async listPendingDecisions(actor) {
    authorize(actor, 'judgment.review', {});
    const rows = await this.repository.listPendingJudgments({
      courtIds: actor.courtIds,
      assigneeSubject: actor.userId
    });
    this._audit(actor, 'judicial.pending_decisions.view', 'judgment_queue', actor.userId, { courtIds: actor.courtIds });
    return rows;
  }
}

module.exports = { JudicialWorkbenchService };
