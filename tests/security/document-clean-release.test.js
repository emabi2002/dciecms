'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { resolveActorFromClaims }=require('../../packages/auth');
const { MemoryDocumentStorage }=require('../../services/api/src/document-storage');
const { SecureDocumentService }=require('../../services/api/src/secure-document-service');
const { DocumentScanWorker }=require('../../services/api/src/document-scan-worker');

const NOW='2026-09-07T02:00:00.000Z';
const actor=resolveActorFromClaims({sub:'reg-a',roles:['REG'],court_ids:['COURT-A'],explicit_grants:[]});

function fixture(scanStatus){
  const document={
    documentId:'DOC-1',filingId:'F-1',courtId:'COURT-A',fileName:'claim.pdf',mimeType:'application/pdf',
    sizeBytes:100,checksumSha256:'c'.repeat(64),status:'QUARANTINED',classification:'CONFIDENTIAL',
    storageObjectKey:'quarantine/COURT-A/DOC-1/claim.pdf',expectedSizeBytes:100,detectedMimeType:'application/pdf',
    scanStatus:'PENDING',scanResult:null,releasedAt:null,versionNumber:1
  };
  const state={document:Object.freeze(document)};
  const repository={
    async getDocument(){return state.document;},
    async getFiling(){return {filingId:'F-1',courtId:'COURT-A'};},
    async activateCleanDocument(input){state.document=Object.freeze({...state.document,status:'ACTIVE',scanStatus:'CLEAN',scanResult:'CLEAN',releasedAt:input.releasedAt,scannerEngine:input.scannerEngine,scannerVersion:input.scannerVersion});return state.document;},
    async rejectDocumentAfterScan(input){state.document=Object.freeze({...state.document,status:'REJECTED',scanStatus:input.scanStatus,scanResult:input.scanResult});return state.document;}
  };
  const job={scanJobId:'SCAN-1',documentId:'DOC-1',status:'LEASED',attemptCount:0,maxAttempts:5};
  const scanStore={
    async claimDue(){return [job];},
    async markClean(){return {...job,status:'SUCCEEDED',resultCode:'CLEAN'};},
    async markInfected(){return {...job,status:'SUCCEEDED',resultCode:'INFECTED'};},
    async markRetryableFailure(){return {...job,status:'FAILED_RETRYABLE',resultCode:'ERROR_RETRYABLE'};},
    async markPermanentFailure(input){return {...job,status:'DEAD_LETTER',resultCode:input.resultCode};}
  };
  const scanner={async scan(){if(scanStatus instanceof Error)throw scanStatus;return {status:scanStatus,engine:'fixture',version:'1'};}};
  const auditStore={async append(event){return event;}};
  const tx={async withTransaction(work){return work();}};
  const storage=new MemoryDocumentStorage();
  storage.putObjectMetadata({
    objectKey:document.storageObjectKey,
    sizeBytes:document.sizeBytes,
    checksumSha256:document.checksumSha256,
    detectedMimeType:document.detectedMimeType
  });
  const secure=new SecureDocumentService({repository,storage,auditStore,clock:()=>new Date(NOW)});
  const worker=new DocumentScanWorker({repository,scanStore,storage,scanner,auditStore,transactionManager:tx,workerId:'worker-a',clock:()=>new Date(NOW)});
  return {state,secure,worker};
}

test('quarantined document is not downloadable until a CLEAN scan releases that exact record',async()=>{
  const f=fixture('CLEAN');
  await assert.rejects(()=>f.secure.authorizeDocumentDownload(actor,'DOC-1'),/ACTIVE|released/i);
  await f.worker.runOnce();
  assert.equal(f.state.document.status,'ACTIVE');
  const grant=await f.secure.authorizeDocumentDownload(actor,'DOC-1');
  assert.equal(grant.documentId,'DOC-1');
  assert.equal(grant.downloadGrant.objectKey,'quarantine/COURT-A/DOC-1/claim.pdf');
});

test('infected, scanner-error, and unsupported results never create a downloadable document',async()=>{
  for (const result of ['INFECTED','ERROR_RETRYABLE','UNSUPPORTED',new Error('scanner unavailable')]) {
    const f=fixture(result);
    await f.worker.runOnce();
    assert.notEqual(f.state.document.status,'ACTIVE');
    await assert.rejects(()=>f.secure.authorizeDocumentDownload(actor,'DOC-1'),/ACTIVE|released/i);
  }
});
