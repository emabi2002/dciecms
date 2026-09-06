'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { JudicialOperationsService } = require('../../services/api/src/judicial-operations-service');
const { JudicialWorkbenchService } = require('../../services/api/src/judicial-workbench-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const actor = resolveActorFromClaims({ sub: 'mag-a', roles: ['MAG'], court_ids: [COURT_A] });

function deferredAudit() {
  let resolve;
  return {
    auditStore: { append() { return new Promise(done => { resolve = done; }); } },
    resolve() { resolve({ auditEventId: 'audit-1' }); }
  };
}

async function assertWaitsForAudit(operationFactory, audit) {
  let settled = false;
  const operation = operationFactory();
  operation.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'judicial operation must await audit persistence');
  audit.resolve();
  return operation;
}

test('judicial operations wait for audit persistence before returning My Cases', async () => {
  const audit = deferredAudit();
  const repository = {
    async listAssignedCases() { return []; }
  };
  const service = new JudicialOperationsService({ repository, auditStore: audit.auditStore });
  const rows = await assertWaitsForAudit(() => service.listMyCases(actor), audit);
  assert.deepEqual(rows, []);
});

test('Judicial Workbench waits for audit persistence before returning Pending Decisions', async () => {
  const audit = deferredAudit();
  const repository = {
    async listPendingJudgments() { return []; }
  };
  const service = new JudicialWorkbenchService({ repository, auditStore: audit.auditStore });
  const rows = await assertWaitsForAudit(() => service.listPendingDecisions(actor), audit);
  assert.deepEqual(rows, []);
});
