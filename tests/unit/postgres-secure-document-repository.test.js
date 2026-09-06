'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresRepository } = require('../../services/api/src/postgres-repository');

function documentRow(overrides = {}) {
  return {
    document_id:'d-1', filing_id:'f-1', court_id:'c-1', file_name:'claim.pdf',
    mime_type:'application/pdf', size_bytes:12, checksum_sha256:'a'.repeat(64),
    status:'QUARANTINED', classification:'CONFIDENTIAL', created_at:'2026-09-07T00:00:00.000Z',
    storage_object_key:'quarantine/c-1/d-1/claim.pdf', version_number:1,
    prior_document_id:null, superseded_by_document_id:null, expected_size_bytes:12,
    detected_mime_type:'application/pdf', created_by_subject:'reg-a',
    finalized_at:'2026-09-07T00:01:00.000Z', finalized_by_subject:'reg-a',
    file_policy_result:'PASSED', file_policy_code:null, scan_status:'PENDING', scan_result:null,
    scanner_engine:null, scanner_version:null, released_at:null,
    withdrawn_at:null, withdrawn_by_subject:null, withdrawal_reason:null,
    legal_hold:false, legal_hold_reference:null, disposition_eligible_at:null,
    ...overrides
  };
}

class FakeQueryable {
  constructor(responses = []) { this.responses=[...responses]; this.calls=[]; }
  async query(text, params=[]) {
    this.calls.push({text,params});
    const next=this.responses.shift();
    if (next instanceof Error) throw next;
    return next || {rows:[]};
  }
}

test('createDocumentUploadIntent persists server object key and UPLOAD_PENDING with parameterized SQL', async () => {
  const row=documentRow({status:'UPLOAD_PENDING',size_bytes:0,checksum_sha256:null,detected_mime_type:null,finalized_at:null,file_policy_result:'NOT_CHECKED',scan_status:'NOT_REQUESTED'});
  const db=new FakeQueryable([{rows:[row]}]);
  const repo=new PostgresRepository(db);
  const doc=await repo.createDocumentUploadIntent({
    documentId:'d-1', filingId:'f-1', courtId:'c-1', fileName:'claim.pdf',
    mimeType:'application/pdf', expectedSizeBytes:12, classification:'CONFIDENTIAL',
    storageObjectKey:'quarantine/c-1/d-1/claim.pdf', actorSubject:'reg-a'
  });
  assert.equal(doc.status,'UPLOAD_PENDING');
  assert.equal(doc.storageObjectKey,'quarantine/c-1/d-1/claim.pdf');
  assert.equal(doc.expectedSizeBytes,12);
  assert.match(db.calls[0].text,/INSERT INTO documents\.documents/i);
  assert.match(db.calls[0].text,/UPLOAD_PENDING/i);
  assert.equal(db.calls[0].text.includes('quarantine/c-1/d-1/claim.pdf'),false);
  assert.equal(db.calls[0].params.includes('quarantine/c-1/d-1/claim.pdf'),true);
});

test('getDocument maps secure storage, scan, release, lineage and retention evidence', async () => {
  const db=new FakeQueryable([{rows:[documentRow({status:'ACTIVE',scan_status:'CLEAN',scan_result:'CLEAN',released_at:'2026-09-07T00:02:00.000Z',legal_hold:true,legal_hold_reference:'HOLD-1'})]}]);
  const repo=new PostgresRepository(db);
  const doc=await repo.getDocument('d-1');
  assert.equal(doc.storageObjectKey,'quarantine/c-1/d-1/claim.pdf');
  assert.equal(doc.scanResult,'CLEAN');
  assert.equal(doc.releasedAt,'2026-09-07T00:02:00.000Z');
  assert.equal(doc.legalHold,true);
  assert.equal(doc.legalHoldReference,'HOLD-1');
  assert.match(db.calls[0].text,/storage_object_key/i);
});

test('finalizeDocumentAndCreateScanJob atomically quarantines authoritative object and creates one scan job', async () => {
  const calls=[];
  const finalized=documentRow();
  const client={
    async query(text,params=[]) {
      calls.push({text,params});
      if (/UPDATE documents\.documents/i.test(text)) return {rows:[finalized]};
      if (/INSERT INTO documents\.scan_jobs/i.test(text)) return {rows:[{scan_job_id:'sj-1'}]};
      return {rows:[]};
    },
    release(){calls.push({text:'RELEASE',params:[]});}
  };
  const repo=new PostgresRepository({async connect(){return client;}});
  const doc=await repo.finalizeDocumentAndCreateScanJob({
    documentId:'d-1', scanJobId:'sj-1', actorSubject:'reg-a', sizeBytes:12,
    checksumSha256:'a'.repeat(64), detectedMimeType:'application/pdf',
    finalizedAt:'2026-09-07T00:01:00.000Z'
  });
  assert.equal(doc.status,'QUARANTINED');
  assert.equal(calls[0].text,'BEGIN');
  assert.match(calls[1].text,/status='QUARANTINED'/i);
  assert.match(calls[1].text,/status='UPLOAD_PENDING'/i);
  assert.match(calls[2].text,/INSERT INTO documents\.scan_jobs/i);
  assert.match(calls[2].text,/ON CONFLICT\s*\(document_id\)\s*DO NOTHING/i);
  assert.equal(calls.at(-2).text,'COMMIT');
  assert.equal(calls.at(-1).text,'RELEASE');
});

test('finalizeDocumentAndCreateScanJob replays exact canonical finalization without another scan mutation', async () => {
  const calls=[];
  const canonical=documentRow();
  const client={
    async query(text,params=[]) {
      calls.push({text,params});
      if (/UPDATE documents\.documents/i.test(text)) return {rows:[]};
      if (/SELECT[\s\S]+FROM documents\.documents/i.test(text)) return {rows:[canonical]};
      return {rows:[]};
    },
    release(){calls.push({text:'RELEASE',params:[]});}
  };
  const repo=new PostgresRepository({async connect(){return client;}});
  const doc=await repo.finalizeDocumentAndCreateScanJob({
    documentId:'d-1', scanJobId:'sj-1', actorSubject:'reg-a', sizeBytes:12,
    checksumSha256:'a'.repeat(64), detectedMimeType:'application/pdf',
    finalizedAt:'2026-09-07T00:01:00.000Z'
  });
  assert.equal(doc.status,'QUARANTINED');
  assert.equal(calls.some(call=>/INSERT INTO documents\.scan_jobs/i.test(call.text)),false);
  assert.equal(calls.at(-2).text,'COMMIT');
});

test('conflicting finalization rolls back and exposes stable conflict code', async () => {
  const calls=[];
  const canonical=documentRow({checksum_sha256:'b'.repeat(64)});
  const client={
    async query(text,params=[]) {
      calls.push({text,params});
      if (/UPDATE documents\.documents/i.test(text)) return {rows:[]};
      if (/SELECT[\s\S]+FROM documents\.documents/i.test(text)) return {rows:[canonical]};
      return {rows:[]};
    },
    release(){calls.push({text:'RELEASE',params:[]});}
  };
  const repo=new PostgresRepository({async connect(){return client;}});
  await assert.rejects(
    () => repo.finalizeDocumentAndCreateScanJob({
      documentId:'d-1', scanJobId:'sj-1', actorSubject:'reg-a', sizeBytes:12,
      checksumSha256:'a'.repeat(64), detectedMimeType:'application/pdf',
      finalizedAt:'2026-09-07T00:01:00.000Z'
    }),
    error => error && error.code === 'DOCUMENT_FINALIZE_CONFLICT'
  );
  assert.equal(calls.some(call=>call.text==='ROLLBACK'),true);
});

test('secure document mutations are state-conditional and repository exposes no hard delete', async () => {
  const db=new FakeQueryable([
    {rows:[documentRow({status:'ACTIVE',scan_status:'CLEAN',scan_result:'CLEAN',released_at:'2026-09-07T00:02:00.000Z'})]},
    {rows:[documentRow({classification:'RESTRICTED'})]},
    {rows:[documentRow({status:'SUPERSEDED',superseded_by_document_id:'d-2'})]},
    {rows:[documentRow({status:'WITHDRAWN',withdrawn_at:'2026-09-07T00:03:00.000Z',withdrawn_by_subject:'regmgr-a',withdrawal_reason:'wrong exhibit'})]}
  ]);
  const repo=new PostgresRepository(db);
  const active=await repo.activateCleanDocument({documentId:'d-1',scannerEngine:'fixture',scannerVersion:'1',releasedAt:'2026-09-07T00:02:00.000Z'});
  assert.equal(active.status,'ACTIVE');
  assert.match(db.calls[0].text,/status='QUARANTINED'/i);
  assert.match(db.calls[0].text,/scan_status='CLEAN'/i);

  await repo.changeDocumentClassification({documentId:'d-1',classification:'RESTRICTED'});
  assert.match(db.calls[1].text,/SET classification=\$2/i);

  await repo.supersedeDocument({documentId:'d-1',replacementDocumentId:'d-2'});
  assert.match(db.calls[2].text,/status='SUPERSEDED'/i);
  assert.match(db.calls[2].text,/superseded_by_document_id/i);

  await repo.withdrawDocument({documentId:'d-1',actorSubject:'regmgr-a',reason:'wrong exhibit',at:'2026-09-07T00:03:00.000Z'});
  assert.match(db.calls[3].text,/status='WITHDRAWN'/i);
  assert.equal(typeof repo.deleteDocument,'undefined');
});
