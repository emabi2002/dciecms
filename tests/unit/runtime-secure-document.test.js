'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {SecureDocumentService}=require('../../services/api/src/secure-document-service');
const {DocumentScanWorker}=require('../../services/api/src/document-scan-worker');
const {PostgresDocumentScanStore}=require('../../services/api/src/postgres-document-scan-store');
const {PostgresTransactionManager}=require('../../services/api/src/postgres-transaction-manager');
const {createRuntimeService}=require('../../services/api/src/runtime-service');

class FakePool {
  constructor(options){this.options=options;}
  async query(){return {rows:[]};}
  async connect(){throw new Error('not used by constructor');}
}

test('development in-memory runtime attaches one secure document service without production adapters',()=>{
  const service=createRuntimeService({env:{NODE_ENV:'test'},PoolClass:class UnexpectedPool{}});
  assert.ok(service.secureDocuments instanceof SecureDocumentService);
  assert.equal(typeof service.initiateDocumentUpload,'function');
  assert.equal(typeof service.authorizeDocumentDownload,'function');
});

test('persistent runtime shares repository audit transaction manager and scan store with secure pipeline',()=>{
  const service=createRuntimeService({env:{NODE_ENV:'test',DATABASE_URL:'postgres://example/db'},PoolClass:FakePool});
  assert.ok(service.secureDocuments instanceof SecureDocumentService);
  assert.ok(service.documentScanStore instanceof PostgresDocumentScanStore);
  assert.ok(service.documentScanWorker instanceof DocumentScanWorker);
  assert.ok(service.repository.db instanceof PostgresTransactionManager);
  assert.equal(service.secureDocuments.repository,service.repository);
  assert.equal(service.secureDocuments.auditStore,service.audit);
  assert.equal(service.secureDocuments.scanStore,service.documentScanStore);
  assert.equal(service.documentScanWorker.transactionManager,service.repository.db);
});

test('production runtime leaves secure document pipeline disabled by default',()=>{
  const service=createRuntimeService({env:{NODE_ENV:'production',DATABASE_URL:'postgres://example/db'},PoolClass:FakePool});
  assert.equal(service.secureDocuments,null);
  assert.equal(service.documentScanWorker,undefined);
});

test('production runtime refuses explicitly enabled secure pipeline without approved injected adapters',()=>{
  assert.throws(()=>createRuntimeService({
    env:{NODE_ENV:'production',DATABASE_URL:'postgres://example/db',DCIECMS_DOCUMENT_PIPELINE_MODE:'enabled'},
    PoolClass:FakePool
  }),/production.*storage|adapter/i);
});
