'use strict';
const { authorize } = require('../../../packages/rbac');
const { PersistentDciecmsService } = require('./persistent-dciecms-service');

class FinanceOperationsService extends PersistentDciecmsService {
  async listFinanceQueue(actor, filters = {}) {
    authorize(actor, 'finance.payment.view', {});
    const rows = await this.repository.listFinanceQueue({
      courtIds: actor.courtIds,
      status: filters?.status ? String(filters.status).trim().toUpperCase() : null
    });
    this._audit(actor, 'finance.queue.view', 'finance_queue', actor.courtIds.join(','), {
      courtIds: actor.courtIds,
      status: filters?.status ? String(filters.status).trim().toUpperCase() : null
    });
    return rows;
  }
}

module.exports = { FinanceOperationsService };
