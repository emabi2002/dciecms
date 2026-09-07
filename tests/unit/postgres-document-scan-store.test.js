'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PostgresDocumentScanStore,
  scanRetryDelayMs
} = require('../../services/api/src/postgres-document-scan-store');

class FakeQueryable {
  constructor(responses = []) { this.responses=[...responses]; this.calls=[]; }
  async query(text,params=[]) {
    this.calls.push({text,params});
    const next=this.responses.shift();
    if (next instanceof Error) throw next;
    return next || {rows:[]};
  }
}

function jobRow(overrides={}) {
  return {
    scan_job_id:'sj-1', document_id:'d-1', status:'PENDING', attempt_count:0,
    max_attempts:3, next_attempt_at:'2026-09-07T00:00:00.000Z', lease_owner:null,
    lease_expires_at:null, scanner_engine:null, scanner_version:null,
    result_code:null, last_error_code:null, created_at:'2026-09-07T00:00:00.000Z',
    updated_at:'2026-09-07T00:00:00.000Z', completed_at:null, ...overrides
  };
}

test('scan retry delay uses deterministic capped exponential backoff', () => {
  assert.equal(scanRetryDelayMs(1),30000);
  assert.equal(scanRetryDelayMs(2),60000);
  assert.equal(scanRetryDelayMs(3),120000);
  assert.equal(scanRetryDelayMs(20),3600000);
});

test('claimDue claims due or stale jobs with SKIP LOCKED and explicit lease owner', async () => {
  const db=new FakeQueryable([{rows:[jobRow({status:'LEASED',lease_owner:'worker-a',lease_expires_at:'2026-09-07T00:01:00.000Z'})]}]);
  const store=new PostgresDocumentScanStore(db);
  const rows=await store.claimDue({workerId:'worker-a',limit:10,leaseSeconds:60,now:'2026-09-07T00:00:00.000Z'});
  assert.equal(rows.length,1);
  assert.equal(rows[0].leaseOwner,'worker-a');
  assert.match(db.calls[0].text,/FOR UPDATE SKIP LOCKED/i);
  assert.match(db.calls[0].text,/status IN \('PENDING','FAILED_RETRYABLE'\)/i);
  assert.match(db.calls[0].text,/status='LEASED'/i);
  assert.match(db.calls[0].text,/lease_expires_at/i);
  assert.equal(db.calls[0].params.includes('worker-a'),true);
  assert.equal(db.calls[0].params.includes(10),true);
});

test('markClean succeeds only for lease owner and records sanitized scanner evidence', async () => {
  const db=new FakeQueryable([
    {rows:[jobRow({status:'SUCCEEDED',lease_owner:null,result_code:'CLEAN',scanner_engine:'fixture',scanner_version:'1',completed_at:'2026-09-07T00:00:10.000Z'})]},
    {rows:[]}
  ]);
  const store=new PostgresDocumentScanStore(db);
  const job=await store.markClean({scanJobId:'sj-1',workerId:'worker-a',engine:'fixture',version:'1',completedAt:'2026-09-07T00:00:10.000Z'});
  assert.equal(job.status,'SUCCEEDED');
  assert.equal(job.resultCode,'CLEAN');
  assert.match(db.calls[0].text,/status='LEASED'.*lease_owner=\$2/is);
  assert.match(db.calls[0].text,/result_code='CLEAN'/i);
  await assert.rejects(
    () => store.markClean({scanJobId:'sj-1',workerId:'worker-b',engine:'fixture',version:'1',completedAt:'2026-09-07T00:00:10.000Z'}),
    error => error && error.code === 'SCAN_JOB_OWNERSHIP_CONFLICT'
  );
});

test('markInfected completes lease with INFECTED evidence', async () => {
  const db=new FakeQueryable([{rows:[jobRow({status:'SUCCEEDED',result_code:'INFECTED',completed_at:'2026-09-07T00:00:10.000Z'})]}]);
  const store=new PostgresDocumentScanStore(db);
  const job=await store.markInfected({scanJobId:'sj-1',workerId:'worker-a',engine:'fixture',version:'1',completedAt:'2026-09-07T00:00:10.000Z'});
  assert.equal(job.resultCode,'INFECTED');
  assert.match(db.calls[0].text,/result_code='INFECTED'/i);
});

test('retryable scan failure increments attempts and can transition to DEAD_LETTER', async () => {
  const db=new FakeQueryable([
    {rows:[jobRow({status:'FAILED_RETRYABLE',attempt_count:1,last_error_code:'SCAN_UNAVAILABLE',next_attempt_at:'2026-09-07T00:00:30.000Z'})]},
    {rows:[jobRow({status:'DEAD_LETTER',attempt_count:3,last_error_code:'SCAN_UNAVAILABLE'})]}
  ]);
  const store=new PostgresDocumentScanStore(db);
  const retry=await store.markRetryableFailure({scanJobId:'sj-1',workerId:'worker-a',errorCode:'SCAN_UNAVAILABLE',nextAttemptAt:'2026-09-07T00:00:30.000Z',attemptedAt:'2026-09-07T00:00:00.000Z'});
  assert.equal(retry.status,'FAILED_RETRYABLE');
  assert.match(db.calls[0].text,/attempt_count=attempt_count\+1/i);
  assert.match(db.calls[0].text,/DEAD_LETTER/i);
  assert.match(db.calls[0].text,/lease_owner=\$2/i);

  const dead=await store.markRetryableFailure({scanJobId:'sj-1',workerId:'worker-a',errorCode:'SCAN_UNAVAILABLE',nextAttemptAt:'2026-09-07T00:01:00.000Z',attemptedAt:'2026-09-07T00:00:30.000Z'});
  assert.equal(dead.status,'DEAD_LETTER');
});

test('permanent failure dead-letters without creating a clean result', async () => {
  const db=new FakeQueryable([{rows:[jobRow({status:'DEAD_LETTER',result_code:'UNSUPPORTED',last_error_code:'UNSUPPORTED',completed_at:'2026-09-07T00:00:10.000Z'})]}]);
  const store=new PostgresDocumentScanStore(db);
  const job=await store.markPermanentFailure({scanJobId:'sj-1',workerId:'worker-a',resultCode:'UNSUPPORTED',completedAt:'2026-09-07T00:00:10.000Z'});
  assert.equal(job.status,'DEAD_LETTER');
  assert.equal(job.resultCode,'UNSUPPORTED');
  assert.notEqual(job.resultCode,'CLEAN');
});

test('retryDeadLetter only resets a dead-letter job and never writes CLEAN', async () => {
  const db=new FakeQueryable([{rows:[jobRow({status:'PENDING',attempt_count:0,next_attempt_at:'2026-09-07T00:05:00.000Z'})]}]);
  const store=new PostgresDocumentScanStore(db);
  const job=await store.retryDeadLetter({scanJobId:'sj-1',nextAttemptAt:'2026-09-07T00:05:00.000Z'});
  assert.equal(job.status,'PENDING');
  assert.match(db.calls[0].text,/WHERE scan_job_id=\$1 AND status='DEAD_LETTER'/i);
  assert.equal(/CLEAN/i.test(db.calls[0].text),false);
});
