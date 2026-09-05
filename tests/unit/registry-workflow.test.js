'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveActorFromClaims } = require('../../packages/auth');
const { DciecmsService, ConflictError, ValidationError } = require('../../services/api/src/dciecms-service');

const regA = resolveActorFromClaims({ sub: 'reg-a', roles: ['REG'], court_ids: ['COURT-A'] });
const regB = resolveActorFromClaims({ sub: 'reg-b', roles: ['REG'], court_ids: ['COURT-B'] });

function submittedFiling() {
  const svc = new DciecmsService();
  const party = svc.createParty(regA, { courtId: 'COURT-A', partyType: 'PERSON', displayName: 'Jane Doe' });
  const filing = svc.createFilingDraft(regA, { courtId: 'COURT-A', caseTypeCode: 'CIVIL', filerPartyId: party.partyId });
  const submitted = svc.submitFiling(regA, filing.filingId, 'submit-1');
  return { svc, filing: submitted };
}

test('filing draft rejects an unknown case type', () => {
  const svc = new DciecmsService();
  const party = svc.createParty(regA, { courtId: 'COURT-A', partyType: 'PERSON', displayName: 'Jane Doe' });
  assert.throws(
    () => svc.createFilingDraft(regA, { courtId: 'COURT-A', caseTypeCode: 'NOT-A-CASE-TYPE', filerPartyId: party.partyId }),
    ValidationError
  );
});

test('submission creates exactly one pending registry validation task', () => {
  const { svc, filing } = submittedFiling();
  let tasks = svc.listWorkflowTasks(regA);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].filingId, filing.filingId);
  assert.equal(tasks[0].taskType, 'REGISTRY_VALIDATE_FILING');
  assert.equal(tasks[0].status, 'PENDING');

  svc.submitFiling(regA, filing.filingId, 'submit-1');
  tasks = svc.listWorkflowTasks(regA);
  assert.equal(tasks.length, 1);
});

test('registry validation transitions filing and completes the workflow task', () => {
  const { svc, filing } = submittedFiling();
  const validated = svc.validateFiling(regA, filing.filingId);
  assert.equal(validated.status, 'VALIDATED');
  assert.equal(validated.validatedBy, 'reg-a');
  assert.ok(validated.validatedAt);

  const active = svc.listWorkflowTasks(regA);
  assert.equal(active.length, 0);

  const all = svc.listWorkflowTasks(regA, { includeCompleted: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'COMPLETED');
  assert.equal(all[0].completedBy, 'reg-a');
  assert.ok(all[0].completedAt);
});

test('registry user outside court scope cannot validate filing', () => {
  const { svc, filing } = submittedFiling();
  assert.throws(() => svc.validateFiling(regB, filing.filingId), /court scope/i);
});

test('draft filing cannot be validated before submission', () => {
  const svc = new DciecmsService();
  const party = svc.createParty(regA, { courtId: 'COURT-A', partyType: 'PERSON', displayName: 'Jane Doe' });
  const filing = svc.createFilingDraft(regA, { courtId: 'COURT-A', caseTypeCode: 'CIVIL', filerPartyId: party.partyId });
  assert.throws(() => svc.validateFiling(regA, filing.filingId), ConflictError);
});

test('R0/R1 migration adds case type configuration, filing validation evidence and workflow tasks', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'db/migrations/0002_config_workflow.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS config\.case_types/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS validated_at timestamptz/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS validated_by_subject varchar\(255\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS workflow\.workflow_tasks/i);
  assert.match(sql, /REGISTRY_VALIDATE_FILING/i);
  assert.match(sql, /filing_id uuid NOT NULL REFERENCES registry\.filings\(filing_id\)/i);
});
