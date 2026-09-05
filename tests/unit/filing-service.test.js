'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { DciecmsService } = require('../../services/api/src/dciecms-service');

const regA = resolveActorFromClaims({sub:'reg-a', roles:['REG'], court_ids:['COURT-A']});
const regB = resolveActorFromClaims({sub:'reg-b', roles:['REG'], court_ids:['COURT-B']});

test('registry user creates party inside own court scope', () => {
  const svc = new DciecmsService();
  const party = svc.createParty(regA, {courtId:'COURT-A', partyType:'PERSON', displayName:'Jane Doe'});
  assert.equal(party.courtId, 'COURT-A');
  assert.equal(party.displayName, 'Jane Doe');
});

test('registry user creates filing draft linked to a party', () => {
  const svc = new DciecmsService();
  const party = svc.createParty(regA, {courtId:'COURT-A', partyType:'PERSON', displayName:'Jane Doe'});
  const filing = svc.createFilingDraft(regA, {courtId:'COURT-A', caseTypeCode:'CIVIL', filerPartyId:party.partyId});
  assert.equal(filing.status, 'DRAFT');
  assert.equal(filing.filerPartyId, party.partyId);
});

test('cross-court registry user cannot get filing', () => {
  const svc = new DciecmsService();
  const party = svc.createParty(regA, {courtId:'COURT-A', partyType:'PERSON', displayName:'Jane Doe'});
  const filing = svc.createFilingDraft(regA, {courtId:'COURT-A', caseTypeCode:'CIVIL', filerPartyId:party.partyId});
  assert.throws(() => svc.getFiling(regB, filing.filingId), /court scope/i);
});
