'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DocumentScanWorker } = require('../../services/api/src/document-scan-worker');

const NOW='2026-09-07T01:00:00.000Z';
const DOCUMENT=Object.freeze({
  documentId:'DOC-1', filingId:'F-1', courtId:'COURT-A', status:'QUARANTINED',
  classification:'CONFIDENTIAL', storageObjectKey:'quarantine/COURT-A/DOC-1/claim.pdf',
  checksumSha256:'a'.repeat(64), sizeBytes:123, detectedMimeType:'application/pdf',
  scanStatus:'PENDING', releasedAt:null
});
const JOB=Object.freeze({scanJobId:'SCAN-1',documentId:'DOC-1',status:'LEASED',attemptCount:0,maxAttempts:5});

function harness(scanResult={status:'CLEAN',engine:'fixture',version:'1'}, {
  storageEvidence={
    objectKey:DOCUMENT.storageObjectKey,
    checksumSha256:DOCUMENT.checksumSha256,
    sizeBytes:DOCUMENT.sizeBytes,
    detectedMimeType:DOCUMENT.detectedMimeType
  },
  storageError=null
}={}) {
  const calls=[];
  const state={document:DOCUMENT};
  const repository={
    async getDocument(id){ calls.push(['getDocument',id]); return id==='DOC-1'?state.document:null; },
    async activateCleanDocument(input){ calls.push(['activateCleanDocument',input]); state.document=Object.freeze({...state.document,status:'ACTIVE',scanStatus:'CLEAN',scanResult:'CLEAN',scannerEngine:input.scannerEngine,scannerVersion:input.scannerVersion,releasedAt:input.releasedAt}); return state.document; },
    async rejectDocumentAfterScan(input){ calls.push(['rejectDocumentAfterScan',input]); state.document=Object.freeze({...state.document,status:'REJECTED',scanStatus:input.scanStatus,scanResult:input.scanResult,scannerEngine:input.scannerEngine,scannerVersion:input.scannerVersion}); return state.document; }
  };
  const scanStore={
    async claimDue(input){ calls.push(['claimDue',input]); return [JOB]; },
    async markClean(input){ calls.push(['markClean',input]); return Object.freeze({...JOB,status:'SUCCEEDED',resultCode:'CLEAN'}); },
    async markInfected(input){ calls.push(['markInfected',input]); return Object.freeze({...JOB,status:'SUCCEEDED',resultCode:'INFECTED'}); },
    async markRetryableFailure(input){ calls.push(['markRetryableFailure',input]); return Object.freeze({...JOB,status:'FAILED_RETRYABLE',attemptCount:1,resultCode:'ERROR_RETRYABLE'}); },
    async markPermanentFailure(input){ calls.push(['markPermanentFailure',input]); return Object.freeze({...JOB,status:'DEAD_LETTER',attemptCount:1,resultCode:input.resultCode}); }
  };
  const storage={async headObject(input){calls.push(['headObject',input]); if(storageError) throw storageError; return Object.freeze({...storageEvidence});}};
  const scanner={async scan(input){ calls.push(['scan',input]); if(scanResult instanceof Error) throw scanResult; return scanResult; }};
  const auditStore={async append(event){ calls.push(['audit',event]); return Object.freeze({...event}); }};
  const transactionManager={async withTransaction(work){ calls.push(['tx.begin']); try{const result=await work();calls.push(['tx.commit']);return result;}catch(error){calls.push(['tx.rollback']);throw error;} }};
  const worker=new DocumentScanWorker({repository,scanStore,storage,scanner,auditStore,transactionManager,workerId:'worker-a',clock:()=>new Date(NOW)});
  return {worker,calls,state};
}

function callNames(calls){return calls.map(call=>call[0]);}

test('CLEAN scan activates exact quarantined document and completes job inside one transaction',async()=>{
  const h=harness();
  const result=await h.worker.runOnce();
  assert.equal(result.claimed,1);
  assert.equal(result.clean,1);
  assert.equal(h.state.document.status,'ACTIVE');
  assert.deepEqual(callNames(h.calls),['claimDue','getDocument','headObject','scan','tx.begin','activateCleanDocument','markClean','audit','tx.commit']);
  const scanCall=h.calls.find(call=>call[0]==='scan')[1];
  assert.deepEqual(scanCall,{documentId:'DOC-1',objectKey:DOCUMENT.storageObjectKey,checksumSha256:DOCUMENT.checksumSha256,sizeBytes:123,mimeType:'application/pdf'});
  const audit=h.calls.find(call=>call[0]==='audit')[1];
  assert.equal(audit.action,'document.scan.clean');
  assert.equal(JSON.stringify(audit).includes(DOCUMENT.storageObjectKey),false);
});

test('storage metadata failure is retryable and scanner is never invoked',async()=>{
  const h=harness({status:'CLEAN',engine:'fixture',version:'1'},{storageError:new Error('private-storage-token=secret')});
  const result=await h.worker.runOnce();
  assert.equal(result.retryable,1);
  assert.equal(h.state.document.status,'QUARANTINED');
  assert.equal(callNames(h.calls).includes('scan'),false);
  assert.equal(callNames(h.calls).includes('activateCleanDocument'),false);
  const failed=h.calls.find(call=>call[0]==='markRetryableFailure')[1];
  assert.equal(failed.errorCode,'STORAGE_UNAVAILABLE');
  assert.equal(JSON.stringify(h.calls.filter(call=>call[0]==='audit')).includes('secret'),false);
});

test('scan-time storage integrity drift fails closed and cannot activate document',async()=>{
  const h=harness({status:'CLEAN',engine:'fixture',version:'1'},{storageEvidence:{
    objectKey:DOCUMENT.storageObjectKey,
    checksumSha256:'b'.repeat(64),
    sizeBytes:DOCUMENT.sizeBytes,
    detectedMimeType:DOCUMENT.detectedMimeType
  }});
  const result=await h.worker.runOnce();
  assert.equal(result.permanentFailure,1);
  assert.equal(h.state.document.status,'REJECTED');
  assert.equal(callNames(h.calls).includes('scan'),false);
  assert.equal(callNames(h.calls).includes('activateCleanDocument'),false);
  assert.equal(callNames(h.calls).includes('markClean'),false);
});

test('INFECTED scan rejects document and records terminal infected job without releasing access',async()=>{
  const h=harness({status:'INFECTED',engine:'fixture',version:'1'});
  const result=await h.worker.runOnce();
  assert.equal(result.infected,1);
  assert.equal(h.state.document.status,'REJECTED');
  assert.equal(h.state.document.releasedAt,null);
  assert.deepEqual(callNames(h.calls),['claimDue','getDocument','headObject','scan','tx.begin','rejectDocumentAfterScan','markInfected','audit','tx.commit']);
});

test('retryable scanner result leaves document quarantined and schedules bounded retry',async()=>{
  const h=harness({status:'ERROR_RETRYABLE',engine:'fixture',version:'1'});
  const result=await h.worker.runOnce();
  assert.equal(result.retryable,1);
  assert.equal(h.state.document.status,'QUARANTINED');
  assert.equal(callNames(h.calls).includes('activateCleanDocument'),false);
  const failed=h.calls.find(call=>call[0]==='markRetryableFailure')[1];
  assert.equal(failed.scanJobId,'SCAN-1');
  assert.equal(failed.workerId,'worker-a');
  assert.equal(failed.errorCode,'SCAN_RETRYABLE');
  assert.ok(Date.parse(failed.nextAttemptAt)>Date.parse(NOW));
});

test('scanner exception is sanitized into retryable failure and raw provider error never enters audit',async()=>{
  const h=harness(new Error('secret-provider-host: token=abc123'));
  const result=await h.worker.runOnce();
  assert.equal(result.retryable,1);
  const failed=h.calls.find(call=>call[0]==='markRetryableFailure')[1];
  assert.equal(failed.errorCode,'SCAN_UNAVAILABLE');
  const audits=h.calls.filter(call=>call[0]==='audit').map(call=>call[1]);
  assert.equal(JSON.stringify(audits).includes('abc123'),false);
});

test('unsupported or permanent result rejects document and dead-letters without clean release',async()=>{
  for (const status of ['UNSUPPORTED','ERROR_PERMANENT']) {
    const h=harness({status,engine:'fixture',version:'1'});
    const result=await h.worker.runOnce();
    assert.equal(result.permanentFailure,1);
    assert.equal(h.state.document.status,'REJECTED');
    assert.equal(h.state.document.releasedAt,null);
    const dead=h.calls.find(call=>call[0]==='markPermanentFailure')[1];
    assert.equal(dead.resultCode,status);
    assert.equal(callNames(h.calls).includes('markClean'),false);
  }
});

test('non-quarantined document is never scanned or activated and the leased job is failed closed',async()=>{
  const h=harness();
  h.state.document=Object.freeze({...DOCUMENT,status:'ACTIVE',releasedAt:NOW,scanStatus:'CLEAN'});
  const result=await h.worker.runOnce();
  assert.equal(result.permanentFailure,1);
  assert.equal(callNames(h.calls).includes('headObject'),false);
  assert.equal(callNames(h.calls).includes('scan'),false);
  assert.equal(callNames(h.calls).includes('activateCleanDocument'),false);
  const dead=h.calls.find(call=>call[0]==='markPermanentFailure')[1];
  assert.equal(dead.resultCode,'ERROR_PERMANENT');
});

test('malformed scanner response fails closed as retryable and cannot release document',async()=>{
  const h=harness({status:'MAYBE_CLEAN',raw:'unsafe'});
  const result=await h.worker.runOnce();
  assert.equal(result.retryable,1);
  assert.equal(h.state.document.status,'QUARANTINED');
  assert.equal(callNames(h.calls).includes('activateCleanDocument'),false);
  assert.equal(JSON.stringify(h.calls.filter(call=>call[0]==='audit')).includes('MAYBE_CLEAN'),false);
});

test('transaction failure propagates and cannot be reported as successful release',async()=>{
  const h=harness();
  h.worker.transactionManager={async withTransaction(work){h.calls.push(['tx.begin']);await work();h.calls.push(['tx.rollback']);throw new Error('commit failed');}};
  await assert.rejects(()=>h.worker.runOnce(),/commit failed/);
  assert.equal(callNames(h.calls).includes('tx.rollback'),true);
});
