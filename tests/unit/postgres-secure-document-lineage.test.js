'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresRepository } = require('../../services/api/src/postgres-repository');

function row() {
  return {
    document_id:'d-1', filing_id:'f-1', court_id:'c-1', file_name:'claim.pdf',
    mime_type:'application/pdf', size_bytes:12, checksum_sha256:'a'.repeat(64),
    status:'SUPERSEDED', classification:'CONFIDENTIAL', created_at:'2026-09-07T00:00:00.000Z',
    storage_object_key:'quarantine/c-1/d-1/claim.pdf', version_number:1,
    prior_document_id:null, superseded_by_document_id:'d-2', expected_size_bytes:12,
    detected_mime_type:'application/pdf', created_by_subject:'reg-a',
    finalized_at:'2026-09-07T00:01:00.000Z', finalized_by_subject:'reg-a',
    file_policy_result:'PASSED', file_policy_code:null, scan_status:'CLEAN', scan_result:'CLEAN',
    scanner_engine:'fixture', scanner_version:'1', released_at:'2026-09-07T00:02:00.000Z',
    withdrawn_at:null, withdrawn_by_subject:null, withdrawal_reason:null,
    legal_hold:false, legal_hold_reference:null, disposition_eligible_at:null
  };
}

test('PostgreSQL supersede requires replacement to be the direct child version', async () => {
  const calls=[];
  const db={async query(text,params=[]){calls.push({text,params});return {rows:[row()]};}};
  const repo=new PostgresRepository(db);

  await repo.supersedeDocument({documentId:'d-1',replacementDocumentId:'d-2'});

  assert.equal(calls.length,1);
  assert.match(calls[0].text,/replacement\.prior_document_id\s*=\s*original\.document_id/i);
  assert.deepEqual(calls[0].params,['d-1','d-2']);
});
