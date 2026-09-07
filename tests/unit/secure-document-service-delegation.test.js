'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DciecmsService } = require('../../services/api/src/dciecms-service');
const { PersistentDciecmsService } = require('../../services/api/src/persistent-dciecms-service');

const ACTOR = Object.freeze({ userId:'reg-a', roles:['REG-MGR'], courtIds:['COURT-A'], explicitGrants:[] });

const CASES = Object.freeze([
  ['initiateDocumentUpload', [ACTOR, 'filing-1', {fileName:'claim.pdf'}]],
  ['finalizeDocumentUpload', [ACTOR, 'doc-1']],
  ['authorizeDocumentDownload', [ACTOR, 'doc-1']],
  ['changeDocumentClassification', [ACTOR, 'doc-1', {classification:'RESTRICTED',reason:'Court direction'}]],
  ['createReplacementDocument', [ACTOR, 'doc-1', {fileName:'claim-v2.pdf'}]],
  ['supersedeDocument', [ACTOR, 'doc-1', 'doc-2', 'Corrected filing']],
  ['withdrawDocument', [ACTOR, 'doc-1', 'Filed in error']],
  ['retryDocumentScan', [ACTOR, 'doc-1']]
]);

function secureDelegate() {
  const calls=[];
  const delegate={calls};
  for (const [method] of CASES) {
    delegate[method]=async (...args)=>{
      calls.push({method,args});
      return Object.freeze({delegated:method});
    };
  }
  return delegate;
}

async function assertDelegation(service, delegate) {
  for (const [method,args] of CASES) {
    assert.equal(typeof service[method], 'function', `${method} must be exposed by the facade`);
    const result=await service[method](...args);
    assert.deepEqual(result,{delegated:method});
    const call=delegate.calls.at(-1);
    assert.equal(call.method,method);
    assert.deepEqual(call.args,args);
  }
  assert.equal(delegate.calls.length,CASES.length);
}

test('DciecmsService delegates every secure document lifecycle operation to one injected service', async()=>{
  const delegate=secureDelegate();
  const service=new DciecmsService({secureDocumentService:delegate});
  await assertDelegation(service,delegate);
});

test('PersistentDciecmsService delegates every secure document lifecycle operation to one injected service', async()=>{
  const delegate=secureDelegate();
  const service=new PersistentDciecmsService({repository:{},secureDocumentService:delegate});
  await assertDelegation(service,delegate);
});

test('secure document facade methods fail closed when the secure pipeline is not configured', ()=>{
  const inMemory=new DciecmsService();
  const persistent=new PersistentDciecmsService({repository:{}});
  for (const service of [inMemory,persistent]) {
    assert.throws(
      ()=>service.initiateDocumentUpload(ACTOR,'filing-1',{fileName:'claim.pdf'}),
      /secure document pipeline is not configured/i
    );
  }
});
