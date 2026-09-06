'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { MemoryDocumentStorage } = require('../../services/api/src/document-storage');
const { SecureDocumentService } = require('../../services/api/src/secure-document-service');
const { PostgresDocumentScanStore } = require('../../services/api/src/postgres-document-scan-store');

function manager() {
  return resolveActorFromClaims({
    sub:'mgr-a', roles:['REG-MGR'], court_ids:['COURT-A'], explicit_grants:[]
  });
}

function auditStore() {
  const events=[];
  return { events, async append(event){ events.push(Object.freeze({...event})); return events.at(-1); } };
}

test('retryDocumentScan requeues only the document dead-letter job and audits no provider detail', async () => {
  const document={
    documentId:'DOC-1', filingId:'F-1', courtId:'COURT-A', status:'QUARANTINED',
    classification:'CONFIDENTIAL', storageObjectKey:'quarantine/COURT-A/DOC-1/x.pdf'
  };
  const repository={
    async getDocument(id){ return id==='DOC-1' ? document : null; },
    async getFiling(id){ return id==='F-1' ? {filingId:'F-1',courtId:'COURT-A',createdBy:'owner-a',status:'DRAFT'} : null; }
  };
  const scanStore={
    calls:[],
    async getByDocumentId(id){ return id==='DOC-1' ? {scanJobId:'SCAN-1',documentId:id,status:'DEAD_LETTER'} : null; },
    async retryDeadLetter(input){ this.calls.push(input); return Object.freeze({scanJobId:input.scanJobId,documentId:'DOC-1',status:'PENDING'}); }
  };
  const audit=auditStore();
  const service=new SecureDocumentService({
    repository, storage:new MemoryDocumentStorage(), scanStore, auditStore:audit,
    clock:()=>new Date('2026-09-07T00:00:00.000Z')
  });

  const retried=await service.retryDocumentScan(manager(),'DOC-1');
  assert.equal(retried.status,'PENDING');
  assert.deepEqual(scanStore.calls,[{scanJobId:'SCAN-1',nextAttemptAt:'2026-09-07T00:00:00.000Z'}]);
  assert.equal(audit.events.at(-1).action,'document.scan.retry');
  assert.equal(JSON.stringify(audit.events).includes('memory://'),false);
});

test('PostgresDocumentScanStore resolves the canonical scan job by document id with parameterized SQL', async () => {
  const calls=[];
  const db={ async query(text,params){ calls.push({text,params}); return {rows:[{
    scan_job_id:'SCAN-1', document_id:'DOC-1', status:'DEAD_LETTER', attempt_count:5,
    max_attempts:5, next_attempt_at:'2026-09-07T00:00:00.000Z', lease_owner:null,
    lease_expires_at:null, scanner_engine:null, scanner_version:null, result_code:'ERROR_RETRYABLE',
    last_error_code:'SCAN_UNAVAILABLE', created_at:'2026-09-06T00:00:00.000Z',
    updated_at:'2026-09-07T00:00:00.000Z', completed_at:'2026-09-07T00:00:00.000Z'
  }]}; } };
  const store=new PostgresDocumentScanStore(db);
  const job=await store.getByDocumentId('DOC-1');
  assert.equal(job.scanJobId,'SCAN-1');
  assert.match(calls[0].text,/FROM documents\.scan_jobs/i);
  assert.deepEqual(calls[0].params,['DOC-1']);
});
