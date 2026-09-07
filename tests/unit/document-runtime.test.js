'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryDocumentStorage}=require('../../services/api/src/document-storage');
const {ScriptedMalwareScanner}=require('../../services/api/src/malware-scanner');
const {createDocumentRuntime}=require('../../services/api/src/document-runtime');

function productionStorage(){
  return {
    capabilities(){return {privateObjects:true,encryptionAtRest:true,developmentOnly:false};},
    async createUploadGrant(){return {uploadUrl:'https://private.example/upload',expiresAt:'2099-01-01T00:00:00.000Z'};},
    async headObject(){return {sizeBytes:1,checksumSha256:'a'.repeat(64),detectedMimeType:'application/pdf'};},
    async createDownloadGrant(){return {downloadUrl:'https://private.example/download',expiresAt:'2099-01-01T00:00:00.000Z'};}
  };
}

const productionScanner={async scan(){return {status:'CLEAN',engine:'approved',version:'1'};}};

test('non-production document runtime defaults to explicit development adapters',()=>{
  const runtime=createDocumentRuntime({env:{NODE_ENV:'test'}});
  assert.equal(runtime.enabled,true);
  assert.equal(runtime.mode,'development');
  assert.ok(runtime.storage instanceof MemoryDocumentStorage);
  assert.ok(runtime.scanner instanceof ScriptedMalwareScanner);
});

test('production document runtime stays disabled unless explicitly enabled',()=>{
  const runtime=createDocumentRuntime({env:{NODE_ENV:'production'}});
  assert.deepEqual(runtime,{enabled:false,mode:'disabled',storage:null,scanner:null});
});

test('production enabled mode requires approved injected private encrypted storage and scanner',()=>{
  assert.throws(()=>createDocumentRuntime({env:{NODE_ENV:'production',DCIECMS_DOCUMENT_PIPELINE_MODE:'enabled'}}),/production.*storage|adapter/i);
  assert.throws(()=>createDocumentRuntime({env:{NODE_ENV:'production',DCIECMS_DOCUMENT_PIPELINE_MODE:'enabled'},storage:new MemoryDocumentStorage(),scanner:productionScanner}),/development|encryption/i);
  const storage=productionStorage();
  const runtime=createDocumentRuntime({env:{NODE_ENV:'production',DCIECMS_DOCUMENT_PIPELINE_MODE:'enabled'},storage,scanner:productionScanner});
  assert.equal(runtime.enabled,true);
  assert.equal(runtime.mode,'enabled');
  assert.equal(runtime.storage,storage);
  assert.equal(runtime.scanner,productionScanner);
});

test('unknown document pipeline mode is rejected rather than falling back',()=>{
  assert.throws(()=>createDocumentRuntime({env:{NODE_ENV:'test',DCIECMS_DOCUMENT_PIPELINE_MODE:'mystery'}}),/mode/i);
});
