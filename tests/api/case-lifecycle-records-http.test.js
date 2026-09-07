'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHttpApp } = require('../../services/api/src/http-app');

const actor = Object.freeze({
  userId: 'actor-1',
  roles: ['CMAG'],
  courtIds: ['COURT-A'],
  explicitGrants: []
});

async function withService(service, fn) {
  const server = http.createServer(createHttpApp(service, async () => actor));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function request(base, method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(base + path, options);
  return { response, body: await response.json() };
}

test('HTTP dispatches case lifecycle and records governance routes to the service', async () => {
  const calls = [];
  const service = {
    async disposeCase(_actor, caseId, input) { calls.push(['disposeCase', caseId, input]); return { caseId, status: 'DISPOSED' }; },
    async closeCase(_actor, caseId, input) { calls.push(['closeCase', caseId, input]); return { caseId, status: 'CLOSED' }; },
    async reopenCase(_actor, caseId, input) { calls.push(['reopenCase', caseId, input]); return { caseId, status: 'AWAITING_ASSIGNMENT' }; },
    async getCaseRecordControl(_actor, caseId) { calls.push(['getCaseRecordControl', caseId]); return { caseId, status: 'ARCHIVED' }; },
    async assignRetention(_actor, caseId, input) { calls.push(['assignRetention', caseId, input]); return { caseId, retentionClassCode: input.retentionClassCode }; },
    async archiveCaseRecord(_actor, caseId) { calls.push(['archiveCaseRecord', caseId]); return { caseId, status: 'ARCHIVED' }; },
    async setCaseLegalHold(_actor, caseId, input) { calls.push(['setCaseLegalHold', caseId, input]); return { caseId, legalHold: true }; },
    async releaseCaseLegalHold(_actor, caseId, input) { calls.push(['releaseCaseLegalHold', caseId, input]); return { caseId, legalHold: false }; },
    async requestCaseRecordDisposal(_actor, caseId, input) { calls.push(['requestCaseRecordDisposal', caseId, input]); return { disposalRequestId: 'dr-1', caseId, status: 'REQUESTED' }; },
    async approveCaseRecordDisposal(_actor, requestId, input) { calls.push(['approveCaseRecordDisposal', requestId, input]); return { disposalRequestId: requestId, status: 'APPROVED' }; },
    async rejectCaseRecordDisposal(_actor, requestId, input) { calls.push(['rejectCaseRecordDisposal', requestId, input]); return { disposalRequestId: requestId, status: 'REJECTED' }; }
  };

  await withService(service, async base => {
    const cases = [
      ['POST', '/cases/c-1/disposition', { dispositionCode: 'FINAL_ORDER', reason: 'Final order' }, 200, 'DISPOSED'],
      ['POST', '/cases/c-1/close', { closureCode: 'FINALIZED', reason: 'Closed' }, 200, 'CLOSED'],
      ['POST', '/cases/c-1/reopen', { reason: 'Reopened for review' }, 200, 'AWAITING_ASSIGNMENT'],
      ['GET', '/cases/c-1/records-control', undefined, 200, 'ARCHIVED'],
      ['POST', '/cases/c-1/records-control/retention', { retentionClassCode: 'CIVIL-7Y', retentionTriggerAt: '2026-09-01T00:00:00.000Z', dispositionEligibleAt: '2033-09-01T00:00:00.000Z' }, 200, undefined],
      ['POST', '/cases/c-1/records-control/archive', {}, 200, 'ARCHIVED'],
      ['POST', '/cases/c-1/records-control/legal-hold', { reference: 'HOLD-1', reason: 'Legal hold' }, 200, undefined],
      ['POST', '/cases/c-1/records-control/legal-hold/release', { reason: 'Hold released' }, 200, undefined],
      ['POST', '/cases/c-1/records-control/disposal-requests', { reason: 'Retention expired' }, 201, 'REQUESTED'],
      ['POST', '/records/disposal-requests/dr-1/approve', { reason: 'Approved after review' }, 200, 'APPROVED'],
      ['POST', '/records/disposal-requests/dr-2/reject', { reason: 'Retain longer' }, 200, 'REJECTED']
    ];

    for (const [method, path, body, expectedStatus, expectedState] of cases) {
      const result = await request(base, method, path, body);
      assert.equal(result.response.status, expectedStatus, `${method} ${path}`);
      if (expectedState) assert.equal(result.body.status, expectedState, `${method} ${path}`);
    }
  });

  assert.deepEqual(calls.map(call => call[0]), [
    'disposeCase',
    'closeCase',
    'reopenCase',
    'getCaseRecordControl',
    'assignRetention',
    'archiveCaseRecord',
    'setCaseLegalHold',
    'releaseCaseLegalHold',
    'requestCaseRecordDisposal',
    'approveCaseRecordDisposal',
    'rejectCaseRecordDisposal'
  ]);
  assert.equal(calls[0][1], 'c-1');
  assert.equal(calls[8][1], 'c-1');
  assert.equal(calls[9][1], 'dr-1');
  assert.equal(calls[10][1], 'dr-2');
});

test('HTTP exposes no physical records deletion or disposal execution route', async () => {
  const service = new Proxy({}, {
    get() {
      return async () => { throw new Error('destructive service method must not be called'); };
    }
  });
  await withService(service, async base => {
    for (const [method, path] of [
      ['DELETE', '/cases/c-1'],
      ['DELETE', '/cases/c-1/records-control'],
      ['POST', '/records/disposal-requests/dr-1/execute'],
      ['DELETE', '/records/disposal-requests/dr-1']
    ]) {
      const result = await request(base, method, path);
      assert.equal(result.response.status, 404, `${method} ${path}`);
      assert.deepEqual(result.body, { error: 'not_found' });
    }
  });
});
