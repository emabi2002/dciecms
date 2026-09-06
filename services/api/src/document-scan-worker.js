'use strict';

const { assertMalwareScanner, normalizeScanResult } = require('./malware-scanner');
const { scanRetryDelayMs } = require('./postgres-document-scan-store');

function requiredMethod(value, method, label) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`${label} must expose ${method}()`);
  }
}

function requiredText(value, label) {
  const normalized=String(value || '').trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function normalizeClock(clock) {
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.now === 'function') return ()=>clock.now();
  return ()=>new Date();
}

function emptyRunSummary() {
  return { claimed:0, clean:0, infected:0, retryable:0, permanentFailure:0 };
}

class DocumentScanWorker {
  constructor({
    repository,
    scanStore,
    scanner,
    auditStore,
    transactionManager,
    workerId,
    clock=()=>new Date(),
    batchSize=10,
    leaseSeconds=60,
    retryBaseMs=30000,
    retryCapMs=3600000
  }={}) {
    requiredMethod(repository,'getDocument','repository');
    requiredMethod(repository,'activateCleanDocument','repository');
    requiredMethod(repository,'rejectDocumentAfterScan','repository');
    requiredMethod(scanStore,'claimDue','scanStore');
    requiredMethod(scanStore,'markClean','scanStore');
    requiredMethod(scanStore,'markInfected','scanStore');
    requiredMethod(scanStore,'markRetryableFailure','scanStore');
    requiredMethod(scanStore,'markPermanentFailure','scanStore');
    requiredMethod(auditStore,'append','auditStore');
    requiredMethod(transactionManager,'withTransaction','transactionManager');
    assertMalwareScanner(scanner);
    this.repository=repository;
    this.scanStore=scanStore;
    this.scanner=scanner;
    this.auditStore=auditStore;
    this.transactionManager=transactionManager;
    this.workerId=requiredText(workerId,'workerId');
    this.clock=normalizeClock(clock);
    if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100) throw new TypeError('batchSize must be an integer between 1 and 100');
    if(!Number.isInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>3600) throw new TypeError('leaseSeconds must be an integer between 1 and 3600');
    if(!Number.isInteger(retryBaseMs)||retryBaseMs<1) throw new TypeError('retryBaseMs must be a positive integer');
    if(!Number.isInteger(retryCapMs)||retryCapMs<retryBaseMs) throw new TypeError('retryCapMs must be at least retryBaseMs');
    this.batchSize=batchSize;
    this.leaseSeconds=leaseSeconds;
    this.retryBaseMs=retryBaseMs;
    this.retryCapMs=retryCapMs;
  }

  _nowIso() {
    const value=this.clock();
    const date=value instanceof Date?value:new Date(value);
    if(!Number.isFinite(date.getTime())) throw new TypeError('clock returned an invalid timestamp');
    return date.toISOString();
  }

  _retryAt(job, nowIso) {
    const attemptNumber=Math.max(1,Number(job.attemptCount || 0)+1);
    const delay=scanRetryDelayMs(attemptNumber,this.retryBaseMs,this.retryCapMs);
    return new Date(Date.parse(nowIso)+delay).toISOString();
  }

  _audit(action, document, job, details={}) {
    return this.auditStore.append({
      actorUserId:`system:${this.workerId}`,
      effectiveRoles:['SYSTEM'],
      action,
      resourceType:'document',
      resourceId:document?.documentId || job?.documentId || null,
      courtId:document?.courtId || null,
      correlationId:null,
      details:{
        scanJobId:job?.scanJobId || null,
        ...details
      }
    });
  }

  async _retry(job, document, errorCode, nowIso) {
    const nextAttemptAt=this._retryAt(job,nowIso);
    return this.transactionManager.withTransaction(async()=>{
      const scanJob=await this.scanStore.markRetryableFailure({
        scanJobId:job.scanJobId,
        workerId:this.workerId,
        errorCode,
        nextAttemptAt,
        attemptedAt:nowIso
      });
      await this._audit('document.scan.retryable_failure',document,job,{
        errorCode,
        status:scanJob.status,
        attemptCount:scanJob.attemptCount
      });
      return scanJob;
    });
  }

  async _permanent(job, document, resultCode, nowIso, scanStatus='FAILED') {
    return this.transactionManager.withTransaction(async()=>{
      let rejected=document;
      if(document && document.status==='QUARANTINED') {
        rejected=await this.repository.rejectDocumentAfterScan({
          documentId:document.documentId,
          scanStatus,
          scanResult:resultCode,
          scannerEngine:null,
          scannerVersion:null
        });
      }
      const scanJob=await this.scanStore.markPermanentFailure({
        scanJobId:job.scanJobId,
        workerId:this.workerId,
        resultCode,
        completedAt:nowIso
      });
      await this._audit('document.scan.failed',rejected || document,job,{
        resultCode,
        status:scanJob.status
      });
      return scanJob;
    });
  }

  async _process(job) {
    const nowIso=this._nowIso();
    const document=await this.repository.getDocument(job.documentId);
    if(!document || document.status!=='QUARANTINED') {
      await this._permanent(job,document,'ERROR_PERMANENT',nowIso);
      return 'permanentFailure';
    }

    let rawResult;
    try {
      rawResult=await this.scanner.scan({
        documentId:document.documentId,
        objectKey:document.storageObjectKey,
        checksumSha256:document.checksumSha256,
        sizeBytes:Number(document.sizeBytes),
        mimeType:document.detectedMimeType || document.mimeType
      });
    } catch {
      await this._retry(job,document,'SCAN_UNAVAILABLE',nowIso);
      return 'retryable';
    }

    let result;
    try {
      result=normalizeScanResult(rawResult);
    } catch {
      await this._retry(job,document,'SCAN_RESULT_INVALID',nowIso);
      return 'retryable';
    }

    if(result.status==='ERROR_RETRYABLE') {
      await this._retry(job,document,'SCAN_RETRYABLE',nowIso);
      return 'retryable';
    }

    if(result.status==='CLEAN') {
      await this.transactionManager.withTransaction(async()=>{
        const activated=await this.repository.activateCleanDocument({
          documentId:document.documentId,
          scannerEngine:result.engine,
          scannerVersion:result.version,
          releasedAt:nowIso
        });
        await this.scanStore.markClean({
          scanJobId:job.scanJobId,
          workerId:this.workerId,
          engine:result.engine,
          version:result.version,
          completedAt:nowIso
        });
        await this._audit('document.scan.clean',activated,job,{
          resultCode:'CLEAN',
          engine:result.engine,
          version:result.version,
          released:true
        });
      });
      return 'clean';
    }

    if(result.status==='INFECTED') {
      await this.transactionManager.withTransaction(async()=>{
        const rejected=await this.repository.rejectDocumentAfterScan({
          documentId:document.documentId,
          scanStatus:'INFECTED',
          scanResult:'INFECTED',
          scannerEngine:result.engine,
          scannerVersion:result.version
        });
        await this.scanStore.markInfected({
          scanJobId:job.scanJobId,
          workerId:this.workerId,
          engine:result.engine,
          version:result.version,
          completedAt:nowIso
        });
        await this._audit('document.scan.infected',rejected,job,{
          resultCode:'INFECTED',
          engine:result.engine,
          version:result.version,
          released:false
        });
      });
      return 'infected';
    }

    await this.transactionManager.withTransaction(async()=>{
      const rejected=await this.repository.rejectDocumentAfterScan({
        documentId:document.documentId,
        scanStatus:'FAILED',
        scanResult:result.status,
        scannerEngine:result.engine,
        scannerVersion:result.version
      });
      await this.scanStore.markPermanentFailure({
        scanJobId:job.scanJobId,
        workerId:this.workerId,
        resultCode:result.status,
        completedAt:nowIso
      });
      await this._audit('document.scan.failed',rejected,job,{
        resultCode:result.status,
        engine:result.engine,
        version:result.version,
        released:false
      });
    });
    return 'permanentFailure';
  }

  async runOnce() {
    const nowIso=this._nowIso();
    const jobs=await this.scanStore.claimDue({
      workerId:this.workerId,
      limit:this.batchSize,
      leaseSeconds:this.leaseSeconds,
      now:nowIso
    });
    const summary=emptyRunSummary();
    summary.claimed=jobs.length;
    for(const job of jobs) {
      const outcome=await this._process(job);
      summary[outcome]+=1;
    }
    return Object.freeze({...summary});
  }
}

module.exports={DocumentScanWorker,emptyRunSummary};
