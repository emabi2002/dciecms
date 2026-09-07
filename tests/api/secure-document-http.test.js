'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createHttpApp}=require('../../services/api/src/http-app');
const {resolveActorFromClaims}=require('../../packages/auth');
const {AccessDeniedError}=require('../../packages/rbac');
const {DocumentPolicyError}=require('../../services/api/src/document-policy');
const {SecureDocumentConflictError}=require('../../services/api/src/secure-document-service');

const hdr={'content-type':'application/json','x-dev-sub':'reg-a','x-dev-roles':'REG-MGR','x-dev-courts':'COURT-A'};

async function withService(service,fn){
  const handler=createHttpApp(service,req=>resolveActorFromClaims({
    sub:req.headers['x-dev-sub'],
    roles:String(req.headers['x-dev-roles']||'').split(',').filter(Boolean),
    court_ids:String(req.headers['x-dev-courts']||'').split(',').filter(Boolean)
  }));
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{return await fn(base);} finally {await new Promise(resolve=>server.close(resolve));}
}

test('secure document routes map lifecycle inputs without accepting finalize integrity evidence',async()=>{
  const calls=[];
  const service={
    async initiateDocumentUpload(_actor,id,input){calls.push(['initiate',id,input]);return {document:{documentId:'D-1',status:'UPLOAD_PENDING'},uploadGrant:{uploadUrl:'memory://upload/D-1',expiresAt:'2099-01-01T00:00:00.000Z'}};},
    async finalizeDocumentUpload(_actor,id){calls.push(['finalize',id]);return {documentId:id,status:'QUARANTINED',scanStatus:'PENDING'};},
    async authorizeDocumentDownload(_actor,id){calls.push(['download',id]);return {documentId:id,downloadGrant:{downloadUrl:'memory://download/D-1',expiresAt:'2099-01-01T00:00:00.000Z'}};},
    async changeDocumentClassification(_actor,id,input){calls.push(['classification',id,input]);return {documentId:id,classification:input.classification};},
    async createReplacementDocument(_actor,id,input){calls.push(['replacement',id,input]);return {document:{documentId:'D-2',priorDocumentId:id,status:'UPLOAD_PENDING'}};},
    async supersedeDocument(_actor,id,replacementId,reason){calls.push(['supersede',id,replacementId,reason]);return {documentId:id,status:'SUPERSEDED',supersededByDocumentId:replacementId};},
    async withdrawDocument(_actor,id,reason){calls.push(['withdraw',id,reason]);return {documentId:id,status:'WITHDRAWN'};},
    async retryDocumentScan(_actor,id){calls.push(['retry',id]);return {documentId:id,status:'PENDING'};}
  };
  await withService(service,async base=>{
    let res=await fetch(base+'/filings/F-1/documents/uploads',{method:'POST',headers:hdr,body:JSON.stringify({fileName:'claim.pdf',mimeType:'application/pdf',sizeBytes:12})});
    assert.equal(res.status,201);
    res=await fetch(base+'/documents/D-1/finalize',{method:'POST',headers:hdr,body:JSON.stringify({checksumSha256:'attacker',detectedMimeType:'application/x-msdownload',sizeBytes:999})});
    assert.equal(res.status,200);
    res=await fetch(base+'/documents/D-1/download-authorizations',{method:'POST',headers:hdr,body:'{}'}); assert.equal(res.status,200);
    res=await fetch(base+'/documents/D-1/classification',{method:'POST',headers:hdr,body:JSON.stringify({classification:'RESTRICTED',reason:'Court direction'})}); assert.equal(res.status,200);
    res=await fetch(base+'/documents/D-1/replacements',{method:'POST',headers:hdr,body:JSON.stringify({fileName:'claim-v2.pdf',mimeType:'application/pdf',sizeBytes:15})}); assert.equal(res.status,201);
    res=await fetch(base+'/documents/D-1/supersede',{method:'POST',headers:hdr,body:JSON.stringify({replacementDocumentId:'D-2',reason:'Corrected filing'})}); assert.equal(res.status,200);
    res=await fetch(base+'/documents/D-1/withdraw',{method:'POST',headers:hdr,body:JSON.stringify({reason:'Filed in error'})}); assert.equal(res.status,200);
    res=await fetch(base+'/documents/D-1/retry-scan',{method:'POST',headers:hdr,body:'{}'}); assert.equal(res.status,200);
  });
  assert.deepEqual(calls,[
    ['initiate','F-1',{fileName:'claim.pdf',mimeType:'application/pdf',sizeBytes:12}],
    ['finalize','D-1'],
    ['download','D-1'],
    ['classification','D-1',{classification:'RESTRICTED',reason:'Court direction'}],
    ['replacement','D-1',{fileName:'claim-v2.pdf',mimeType:'application/pdf',sizeBytes:15}],
    ['supersede','D-1','D-2','Corrected filing'],
    ['withdraw','D-1','Filed in error'],
    ['retry','D-1']
  ]);
});

test('secure document HTTP errors map policy/access/conflict safely and never echo provider details',async()=>{
  const service={
    async initiateDocumentUpload(){throw new DocumentPolicyError('Document MIME type is not allowed');},
    async finalizeDocumentUpload(){throw new SecureDocumentConflictError('Document finalization conflict');},
    async authorizeDocumentDownload(){throw new AccessDeniedError('secret storage policy detail');},
    async retryDocumentScan(){throw new Error('scanner-token=super-secret provider.example');}
  };
  await withService(service,async base=>{
    let res=await fetch(base+'/filings/F-1/documents/uploads',{method:'POST',headers:hdr,body:JSON.stringify({fileName:'x.exe',mimeType:'application/x-msdownload',sizeBytes:1})});
    assert.equal(res.status,422); assert.equal((await res.json()).error,'validation_error');
    res=await fetch(base+'/documents/D-1/finalize',{method:'POST',headers:hdr,body:'{}'}); assert.equal(res.status,409); assert.equal((await res.json()).error,'conflict');
    res=await fetch(base+'/documents/D-1/download-authorizations',{method:'POST',headers:hdr,body:'{}'}); assert.equal(res.status,403); assert.deepEqual(await res.json(),{error:'forbidden'});
    res=await fetch(base+'/documents/D-1/retry-scan',{method:'POST',headers:hdr,body:'{}'}); assert.equal(res.status,500); const text=await res.text(); assert.equal(text.includes('super-secret'),false); assert.equal(text.includes('provider.example'),false);
  });
});
