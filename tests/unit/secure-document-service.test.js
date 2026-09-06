'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveActorFromClaims } = require('../../packages/auth');
const { MemoryDocumentStorage } = require('../../services/api/src/document-storage');
const { SecureDocumentService } = require('../../services/api/src/secure-document-service');

function actor({sub='reg-a',roles=['REG'],courts=['COURT-A'],grants=[]}={}) {
  return resolveActorFromClaims({sub,roles,court_ids:courts,explicit_grants:grants});
}

function auditStore() {
  const events=[];
  return {
    events,
    async append(event) { events.push(Object.freeze({...event})); return events.at(-1); }
  };
}

function repositoryFixture() {
  const filings=new Map([['F-1',{filingId:'F-1',courtId:'COURT-A',status:'DRAFT'}]]);
  const documents=new Map();
  const finalizeCalls=[];
  return {
    filings,
    documents,
    finalizeCalls,
    async getFiling(id){ return filings.get(id)||null; },
    async getDocument(id){ return documents.get(id)||null; },
    async createDocumentUploadIntent(input){
      const doc={
        documentId:input.documentId, filingId:input.filingId, courtId:input.courtId,
        fileName:input.fileName, mimeType:input.mimeType, sizeBytes:0, checksumSha256:null,
        status:'UPLOAD_PENDING', classification:input.classification,
        storageObjectKey:input.storageObjectKey, versionNumber:input.versionNumber||1,
        priorDocumentId:input.priorDocumentId||null, supersededByDocumentId:null,
        expectedSizeBytes:input.expectedSizeBytes, detectedMimeType:null,
        createdBySubject:input.actorSubject, finalizedAt:null, scanStatus:'NOT_REQUESTED',
        scanResult:null, releasedAt:null, legalHold:false
      };
      documents.set(doc.documentId,doc);
      return Object.freeze({...doc});
    },
    async finalizeDocumentAndCreateScanJob(input){
      finalizeCalls.push({...input});
      const prior=documents.get(input.documentId);
      const doc={...prior,sizeBytes:input.sizeBytes,checksumSha256:input.checksumSha256,
        detectedMimeType:input.detectedMimeType,status:'QUARANTINED',
        finalizedAt:input.finalizedAt,scanStatus:'PENDING'};
      documents.set(doc.documentId,doc);
      return Object.freeze({...doc});
    },
    async changeDocumentClassification({documentId,classification}){
      const doc={...documents.get(documentId),classification}; documents.set(documentId,doc); return Object.freeze({...doc});
    },
    async supersedeDocument({documentId,replacementDocumentId}){
      const doc={...documents.get(documentId),status:'SUPERSEDED',supersededByDocumentId:replacementDocumentId}; documents.set(documentId,doc); return Object.freeze({...doc});
    },
    async withdrawDocument({documentId,actorSubject,reason,at}){
      const doc={...documents.get(documentId),status:'WITHDRAWN',withdrawnBySubject:actorSubject,withdrawalReason:reason,withdrawnAt:at}; documents.set(documentId,doc); return Object.freeze({...doc});
    }
  };
}

function uuidSequence(values) {
  const queue=[...values];
  return () => {
    if (!queue.length) throw new Error('uuid fixture exhausted');
    return queue.shift();
  };
}

function clock() { return new Date('2026-09-07T00:00:00.000Z'); }

function createFixture({uuids=['DOC-1','SCAN-1','DOC-2']}={}) {
  const repository=repositoryFixture();
  const storage=new MemoryDocumentStorage();
  const audit=auditStore();
  const service=new SecureDocumentService({repository,storage,auditStore:audit,uuid:uuidSequence(uuids),clock});
  return {repository,storage,audit,service};
}

test('initiate upload generates a server-owned quarantine key and never audits the signed upload grant', async () => {
  const {service,audit}=createFixture();
  const result=await service.initiateDocumentUpload(actor(),'F-1',{
    fileName:'claim.pdf',mimeType:'application/pdf',sizeBytes:12,classification:'CONFIDENTIAL'
  });

  assert.equal(result.document.documentId,'DOC-1');
  assert.match(result.objectKey,/^quarantine\/COURT-A\/DOC-1\//);
  assert.equal(result.uploadGrant.objectKey,result.objectKey);
  assert.equal(typeof result.uploadGrant.uploadUrl,'string');
  assert.equal(JSON.stringify(audit.events).includes(result.uploadGrant.uploadUrl),false);
  assert.equal(audit.events.at(-1).action,'document.upload.initiate');
});

test('initiate upload rejects caller-controlled object keys and storage URLs', async () => {
  const {service}=createFixture();
  await assert.rejects(
    () => service.initiateDocumentUpload(actor(),'F-1',{
      fileName:'claim.pdf',mimeType:'application/pdf',sizeBytes:12,
      objectKey:'other-court/secret',storageUrl:'https://public.example/secret'
    }),
    /storage|object key/i
  );
});

test('initiate upload denies cross-court filing access', async () => {
  const {service}=createFixture();
  await assert.rejects(
    () => service.initiateDocumentUpload(actor({courts:['COURT-B']}),'F-1',{
      fileName:'claim.pdf',mimeType:'application/pdf',sizeBytes:12
    }),
    /court scope/i
  );
});

test('finalize uses authoritative storage evidence rather than caller declarations', async () => {
  const {service,storage,repository,audit}=createFixture();
  const initiated=await service.initiateDocumentUpload(actor(),'F-1',{
    fileName:'claim.pdf',mimeType:'application/pdf',sizeBytes:12
  });
  storage.putObjectMetadata({
    objectKey:initiated.objectKey,sizeBytes:12,checksumSha256:'a'.repeat(64),detectedMimeType:'application/pdf'
  });

  const finalized=await service.finalizeDocumentUpload(actor(),'DOC-1');
  assert.equal(finalized.status,'QUARANTINED');
  assert.equal(finalized.checksumSha256,'a'.repeat(64));
  assert.equal(repository.finalizeCalls[0].checksumSha256,'a'.repeat(64));
  assert.equal(repository.finalizeCalls[0].detectedMimeType,'application/pdf');
  assert.equal(repository.finalizeCalls[0].scanJobId,'SCAN-1');
  assert.equal(audit.events.at(-1).action,'document.upload.finalize');
});

test('finalize fails closed on authoritative object mismatch', async () => {
  const {service,storage}=createFixture();
  const initiated=await service.initiateDocumentUpload(actor(),'F-1',{
    fileName:'claim.pdf',mimeType:'application/pdf',sizeBytes:12
  });
  storage.putObjectMetadata({
    objectKey:initiated.objectKey,sizeBytes:13,checksumSha256:'a'.repeat(64),detectedMimeType:'application/pdf'
  });
  await assert.rejects(() => service.finalizeDocumentUpload(actor(),'DOC-1'),/size/i);
});

test('download authorization is active-only, short-lived and does not persist signed URL in audit', async () => {
  const {service,repository,storage,audit}=createFixture();
  repository.documents.set('DOC-A',{
    documentId:'DOC-A',filingId:'F-1',courtId:'COURT-A',fileName:'claim.pdf',mimeType:'application/pdf',
    status:'ACTIVE',classification:'CONFIDENTIAL',storageObjectKey:'active/COURT-A/DOC-A/claim.pdf',
    releasedAt:'2026-09-07T00:00:00.000Z'
  });
  const result=await service.authorizeDocumentDownload(actor(),'DOC-A');
  assert.equal(result.documentId,'DOC-A');
  assert.equal(result.downloadGrant.objectKey,'active/COURT-A/DOC-A/claim.pdf');
  assert.equal(result.downloadGrant.expiresAt,'2026-09-07T00:05:00.000Z');
  assert.equal(JSON.stringify(audit.events).includes(result.downloadGrant.downloadUrl),false);
  assert.equal(audit.events.at(-1).action,'document.download.authorize');

  repository.documents.set('DOC-Q',{...repository.documents.get('DOC-A'),documentId:'DOC-Q',status:'QUARANTINED',releasedAt:null});
  await assert.rejects(() => service.authorizeDocumentDownload(actor(),'DOC-Q'),/active/i);
});

test('RESTRICTED and SEALED downloads require explicit grants in addition to base access', async () => {
  const {service,repository}=createFixture();
  const base={documentId:'DOC-R',filingId:'F-1',courtId:'COURT-A',fileName:'x.pdf',mimeType:'application/pdf',status:'ACTIVE',storageObjectKey:'active/COURT-A/DOC-R/x.pdf',releasedAt:'2026-09-07T00:00:00.000Z'};
  repository.documents.set('DOC-R',{...base,classification:'RESTRICTED'});
  await assert.rejects(() => service.authorizeDocumentDownload(actor(),'DOC-R'),/explicit grant/i);
  await assert.doesNotReject(() => service.authorizeDocumentDownload(actor({grants:['document.restricted.view']}),'DOC-R'));

  repository.documents.set('DOC-S',{...base,documentId:'DOC-S',storageObjectKey:'active/COURT-A/DOC-S/x.pdf',classification:'SEALED'});
  await assert.rejects(() => service.authorizeDocumentDownload(actor({roles:['MAG']}),'DOC-S'),/explicit grant/i);
  await assert.doesNotReject(() => service.authorizeDocumentDownload(actor({roles:['MAG'],grants:['document.sealed.view']}),'DOC-S'));
});

test('classification change is privileged, reasoned and audited', async () => {
  const {service,repository,audit}=createFixture();
  repository.documents.set('DOC-A',{documentId:'DOC-A',filingId:'F-1',courtId:'COURT-A',status:'ACTIVE',classification:'CONFIDENTIAL'});
  await assert.rejects(() => service.changeDocumentClassification(actor(),'DOC-A',{classification:'RESTRICTED',reason:'court order'}),/permission denied/i);
  await assert.rejects(() => service.changeDocumentClassification(actor({roles:['REG-MGR']}),'DOC-A',{classification:'RESTRICTED',reason:' '}),/reason/i);
  const changed=await service.changeDocumentClassification(actor({roles:['REG-MGR']}),'DOC-A',{classification:'RESTRICTED',reason:'court order'});
  assert.equal(changed.classification,'RESTRICTED');
  assert.equal(audit.events.at(-1).action,'document.classification.change');
});

test('replacement creates a new immutable version and supersede keeps prior history', async () => {
  const {service,repository}=createFixture({uuids:['DOC-2']});
  repository.documents.set('DOC-1',{
    documentId:'DOC-1',filingId:'F-1',courtId:'COURT-A',fileName:'old.pdf',mimeType:'application/pdf',
    sizeBytes:10,checksumSha256:'a'.repeat(64),status:'ACTIVE',classification:'CONFIDENTIAL',
    storageObjectKey:'active/COURT-A/DOC-1/old.pdf',versionNumber:1,releasedAt:'2026-09-07T00:00:00.000Z'
  });
  const replacement=await service.createReplacementDocument(actor(),'DOC-1',{
    fileName:'new.pdf',mimeType:'application/pdf',sizeBytes:11
  });
  assert.equal(replacement.document.documentId,'DOC-2');
  assert.equal(replacement.document.priorDocumentId,'DOC-1');
  assert.equal(replacement.document.versionNumber,2);
  assert.equal(repository.documents.get('DOC-1').checksumSha256,'a'.repeat(64));
  assert.notEqual(replacement.document.storageObjectKey,repository.documents.get('DOC-1').storageObjectKey);

  repository.documents.set('DOC-2',{...repository.documents.get('DOC-2'),status:'ACTIVE',releasedAt:'2026-09-07T00:01:00.000Z'});
  const superseded=await service.supersedeDocument(actor({roles:['REG-MGR']}),'DOC-1','DOC-2','corrected filing');
  assert.equal(superseded.status,'SUPERSEDED');
  assert.equal(superseded.supersededByDocumentId,'DOC-2');
});

test('withdrawal requires privilege and reason; no hard-delete API exists', async () => {
  const {service,repository,audit}=createFixture();
  repository.documents.set('DOC-A',{documentId:'DOC-A',filingId:'F-1',courtId:'COURT-A',status:'ACTIVE',classification:'CONFIDENTIAL'});
  await assert.rejects(() => service.withdrawDocument(actor(),'DOC-A','wrong exhibit'),/permission denied/i);
  await assert.rejects(() => service.withdrawDocument(actor({roles:['REG-MGR']}),'DOC-A',' '),/reason/i);
  const withdrawn=await service.withdrawDocument(actor({roles:['REG-MGR']}),'DOC-A','wrong exhibit');
  assert.equal(withdrawn.status,'WITHDRAWN');
  assert.equal(audit.events.at(-1).action,'document.withdraw');
  assert.equal(typeof service.deleteDocument,'undefined');
});
