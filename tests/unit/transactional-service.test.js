'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MUTATING_SERVICE_METHODS,
  createTransactionalService
} = require('../../services/api/src/transactional-service');

const expectedMutations = [
  'createParty',
  'createFilingDraft',
  'registerDocument',
  'submitFiling',
  'validateFiling',
  'returnFiling',
  'rejectFiling',
  'acceptFiling',
  'assessFilingFee',
  'createPayment',
  'createPaymentSession',
  'confirmPayment',
  'issueReceipt',
  'createReconciliation',
  'certifyReconciliation',
  'openCase',
  'assignCase',
  'scheduleHearing',
  'adjournHearing',
  'startHearing',
  'recordAppearance',
  'recordProceeding',
  'completeHearing',
  'createJudgment',
  'updateJudgmentDraft',
  'reviewJudgment',
  'signJudgment',
  'issueJudgment',
  'initiateDocumentUpload',
  'finalizeDocumentUpload',
  'authorizeDocumentDownload',
  'changeDocumentClassification',
  'createReplacementDocument',
  'supersedeDocument',
  'withdrawDocument',
  'retryDocumentScan'
];

test('transactional service registry contains every current HTTP mutation method', () => {
  assert.deepEqual([...MUTATING_SERVICE_METHODS].sort(), [...expectedMutations].sort());
});

test('transactional service registry is immutable to application callers', () => {
  assert.equal(Object.isFrozen(MUTATING_SERVICE_METHODS), true);
  assert.throws(() => MUTATING_SERVICE_METHODS.push('listRegistryQueue'), TypeError);
  assert.deepEqual([...MUTATING_SERVICE_METHODS].sort(), [...expectedMutations].sort());
});

test('createTransactionalService wraps mutations but leaves reads outside transaction boundary', async () => {
  const calls = [];
  const service = {
    marker: 'service',
    async createParty(value) {
      calls.push(`mutate:${this.marker}:${value}`);
      return { value };
    },
    async listRegistryQueue(value) {
      calls.push(`read:${this.marker}:${value}`);
      return [value];
    }
  };
  const transactionManager = {
    async withTransaction(work) {
      calls.push('BEGIN-WRAPPER');
      const result = await work();
      calls.push('END-WRAPPER');
      return result;
    }
  };

  const wrapped = createTransactionalService(service, transactionManager);
  const mutation = await wrapped.createParty('a');
  const read = await wrapped.listRegistryQueue('b');

  assert.deepEqual(mutation, { value: 'a' });
  assert.deepEqual(read, ['b']);
  assert.deepEqual(calls, [
    'BEGIN-WRAPPER',
    'mutate:service:a',
    'END-WRAPPER',
    'read:service:b'
  ]);
});

test('download authorization is transaction-wrapped because it persists audit evidence', async () => {
  const calls=[];
  const service={async authorizeDocumentDownload(){calls.push('authorize');return {ok:true};}};
  const wrapped=createTransactionalService(service,{async withTransaction(work){calls.push('BEGIN');const value=await work();calls.push('COMMIT');return value;}});
  assert.deepEqual(await wrapped.authorizeDocumentDownload(),{ok:true});
  assert.deepEqual(calls,['BEGIN','authorize','COMMIT']);
});

test('payment session creation is transaction-wrapped because provider binding and audit are one mutation boundary', async () => {
  const calls=[];
  const service={async createPaymentSession(){calls.push('session');return {ok:true};}};
  const wrapped=createTransactionalService(service,{async withTransaction(work){calls.push('BEGIN');const value=await work();calls.push('COMMIT');return value;}});
  assert.deepEqual(await wrapped.createPaymentSession(),{ok:true});
  assert.deepEqual(calls,['BEGIN','session','COMMIT']);
});

test('transactional service preserves prototype identity and exposes service properties', () => {
  class ExampleService {}
  const service = new ExampleService();
  service.repository = { name: 'repo' };
  const wrapped = createTransactionalService(service, { withTransaction: work => work() });

  assert.ok(wrapped instanceof ExampleService);
  assert.equal(wrapped.repository, service.repository);
});
