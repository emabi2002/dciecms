# Secure Document Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a provider-neutral, fail-closed secure court-document pipeline from direct quarantine upload through validation, malware scanning, clean-only release, authorized download, immutable versioning and governed retention boundaries.

**Architecture:** Keep document bytes in private object storage behind injected provider-neutral contracts. Persist only opaque object keys and security evidence in PostgreSQL; use a dedicated durable leased scan-job queue; expose server-authorized short-lived grants only after RBAC/court/classification/lifecycle checks. No live provider, KMS, scanner, migration or production deployment is activated by this plan.

**Tech Stack:** Node.js >=20, CommonJS backend, PostgreSQL/`pg`, existing R4 `PostgresTransactionManager`, existing audit/RBAC layers, Node test runner, React/Vite regression suite.

**Spec:** `docs/superpowers/specs/2026-09-07-secure-document-pipeline-design.md`

## Global Constraints

- All document objects remain private; no permanent public object URL is stored or returned.
- Production credentials, provider endpoints, KMS keys/IDs and malware-scanner secrets are not committed.
- Server generates opaque object keys; callers cannot choose storage paths.
- Finalization trusts storage/server-side authoritative evidence, not client declarations alone.
- Only exact normalized `CLEAN` scan results can activate a document.
- Scanner/storage uncertainty fails closed; no manual `mark clean` or `force active` path exists.
- `document.view` plus court/record scope remains mandatory before classification-specific access.
- `RESTRICTED` and `SEALED` add explicit authorization requirements.
- Finalized bytes are immutable; replacement creates a new version.
- Normal application services expose no hard-delete operation.
- Legal hold blocks disposition eligibility, not ordinary authorized evidentiary access.
- Live database migrations, live storage/scanner/KMS activation, production deployment and destructive disposal remain excluded.

---

### Task 1: File policy, classifications and RBAC contract

**Files:**
- Create: `services/api/src/document-policy.js`
- Modify: `packages/rbac/index.js`
- Test: `tests/unit/document-policy.test.js`
- Test: `tests/security/document-classification-rbac.test.js`

**Interfaces:**
- Produces: `validateDocumentIntent(input, policy?) -> normalized intent`
- Produces: `validateAuthoritativeObject(intent, evidence, policy?) -> normalized evidence`
- Produces: `authorizeDocumentClassification(actor, document, operation)`
- Adds permissions: `document.classification.change`, `document.supersede`, `document.withdraw`, `document.scan.retry`
- Adds explicit-grant names used by document logic: `document.restricted.view`, `document.sealed.view`

- [ ] **Step 1: Write failing file-policy tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDocumentIntent, validateAuthoritativeObject } = require('../../services/api/src/document-policy');

test('document intent accepts supported PDF and normalizes extension/mime', () => {
  const value = validateDocumentIntent({ fileName:'claim.PDF', mimeType:'application/pdf', sizeBytes:1024, classification:'CONFIDENTIAL' });
  assert.equal(value.extension, '.pdf');
  assert.equal(value.mimeType, 'application/pdf');
  assert.equal(value.classification, 'CONFIDENTIAL');
});

test('document intent blocks executable/archive types and oversize files', () => {
  assert.throws(() => validateDocumentIntent({ fileName:'payload.exe', mimeType:'application/octet-stream', sizeBytes:100 }), /not allowed/i);
  assert.throws(() => validateDocumentIntent({ fileName:'bundle.zip', mimeType:'application/zip', sizeBytes:100 }), /not allowed/i);
  assert.throws(() => validateDocumentIntent({ fileName:'huge.pdf', mimeType:'application/pdf', sizeBytes:20, classification:'CONFIDENTIAL' }, { maxSizeBytes:10 }), /size/i);
});

test('authoritative evidence rejects extension mime signature mismatch', () => {
  const intent = validateDocumentIntent({ fileName:'claim.pdf', mimeType:'application/pdf', sizeBytes:5 });
  assert.throws(() => validateAuthoritativeObject(intent, { sizeBytes:5, checksumSha256:'a'.repeat(64), detectedMimeType:'application/x-msdownload' }), /content type/i);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test tests/unit/document-policy.test.js`
Expected: FAIL because `document-policy.js` does not exist.

- [ ] **Step 3: Implement strict policy module**

Implement constants and functions with this shape:

```js
const DEFAULT_DOCUMENT_POLICY = Object.freeze({
  maxSizeBytes: 25 * 1024 * 1024,
  types: Object.freeze({
    '.pdf': Object.freeze(['application/pdf']),
    '.doc': Object.freeze(['application/msword']),
    '.docx': Object.freeze(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
    '.xls': Object.freeze(['application/vnd.ms-excel']),
    '.xlsx': Object.freeze(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
    '.jpg': Object.freeze(['image/jpeg']),
    '.jpeg': Object.freeze(['image/jpeg']),
    '.png': Object.freeze(['image/png'])
  }),
  classifications: Object.freeze(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED','SEALED'])
});
```

`validateDocumentIntent()` must require non-empty filename, an allow-listed extension/MIME pair, integer size `>0 && <= maxSizeBytes`, and classification in the allow-list (default `CONFIDENTIAL`). `validateAuthoritativeObject()` must require exact authoritative size, 64-hex SHA-256, and detected MIME consistent with the allowed type for the original extension. Return frozen normalized objects. Never infer type from caller MIME alone.

- [ ] **Step 4: Write classification/RBAC regressions**

```js
const restricted = { courtId:'COURT-A', classification:'RESTRICTED' };
assert.throws(() => authorizeDocumentClassification(regActorWithoutGrant, restricted, 'view'), /explicit grant/i);
assert.doesNotThrow(() => authorizeDocumentClassification(regActorWithRestrictedGrant, restricted, 'view'));
assert.throws(() => authorizeDocumentClassification(magWithoutSealedGrant, {courtId:'COURT-A',classification:'SEALED'}, 'view'), /explicit grant/i);
```

The helper must first call base `authorize(actor, 'document.view', { courtId: document.courtId })`, then require `document.restricted.view` or `document.sealed.view` from `actor.explicitGrants` for those classifications. `PUBLIC`, `INTERNAL` and `CONFIDENTIAL` do not bypass base permission/court scope.

- [ ] **Step 5: Run Task 1 tests GREEN and commit**

Run: `node --test tests/unit/document-policy.test.js tests/security/document-classification-rbac.test.js`
Expected: PASS.

Commit: `feat: define secure document policy and classification controls`

---

### Task 2: Additive document lifecycle and scan-job migration

**Files:**
- Create: `db/migrations/0013_secure_document_pipeline.sql`
- Create: `db/supabase/20260907_dciecms_test_0013.sql`
- Create: `tests/unit/secure-document-migration-contract.test.js`
- Modify: `docs/architecture/IMPLEMENTATION_STATUS.md` only later in Task 8, not in this task.

**Interfaces:**
- Extends `documents.documents` with opaque storage, version, integrity, scan/release, lineage and retention evidence.
- Creates `documents.scan_jobs` with unique canonical job identity, lease/retry/dead-letter fields.

- [ ] **Step 1: Write migration-contract test RED**

```js
const sql = fs.readFileSync(path.join(root,'db/migrations/0013_secure_document_pipeline.sql'),'utf8');
assert.match(sql, /storage_object_key/i);
assert.match(sql, /UPLOAD_PENDING/);
assert.match(sql, /REJECTED/);
assert.match(sql, /CREATE TABLE IF NOT EXISTS documents\.scan_jobs/i);
assert.match(sql, /lease_owner/i);
assert.match(sql, /lease_expires_at/i);
assert.match(sql, /DEAD_LETTER/);
assert.match(sql, /legal_hold/i);
assert.match(sql, /superseded_by_document_id/i);
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/secure-document-migration-contract.test.js`
Expected: FAIL because migration does not exist.

- [ ] **Step 3: Implement migration**

Migration must be additive and transaction-wrapped. Add columns equivalent to:

```sql
ALTER TABLE documents.documents
  ADD COLUMN IF NOT EXISTS storage_object_key text,
  ADD COLUMN IF NOT EXISTS version_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS prior_document_id uuid REFERENCES documents.documents(document_id),
  ADD COLUMN IF NOT EXISTS superseded_by_document_id uuid REFERENCES documents.documents(document_id),
  ADD COLUMN IF NOT EXISTS expected_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS detected_mime_type varchar(120),
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS file_policy_result varchar(30),
  ADD COLUMN IF NOT EXISTS file_policy_code varchar(80),
  ADD COLUMN IF NOT EXISTS scan_status varchar(30) NOT NULL DEFAULT 'NOT_REQUESTED',
  ADD COLUMN IF NOT EXISTS scan_result varchar(30),
  ADD COLUMN IF NOT EXISTS scanner_engine varchar(120),
  ADD COLUMN IF NOT EXISTS scanner_version varchar(120),
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS withdrawal_reason text,
  ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS legal_hold_reference varchar(160),
  ADD COLUMN IF NOT EXISTS disposition_eligible_at timestamptz;
```

Replace the document-status check safely by dropping the named baseline constraint and re-adding allowed states including `UPLOAD_PENDING`, `QUARANTINED`, `ACTIVE`, `REJECTED`, `ARCHIVED`, `SUPERSEDED`, `WITHDRAWN`.

Create scan jobs with fields:

```sql
scan_job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
document_id uuid NOT NULL REFERENCES documents.documents(document_id),
status varchar(30) NOT NULL DEFAULT 'PENDING',
attempt_count integer NOT NULL DEFAULT 0,
max_attempts integer NOT NULL DEFAULT 5,
next_attempt_at timestamptz NOT NULL DEFAULT now(),
lease_owner varchar(160),
lease_expires_at timestamptz,
scanner_engine varchar(120),
scanner_version varchar(120),
result_code varchar(80),
last_error_code varchar(80),
created_at timestamptz NOT NULL DEFAULT now(),
updated_at timestamptz NOT NULL DEFAULT now(),
completed_at timestamptz,
UNIQUE(document_id)
```

Status check: `PENDING`,`LEASED`,`SUCCEEDED`,`FAILED_RETRYABLE`,`DEAD_LETTER`.

Add checks preventing negative attempts, `max_attempts < 1`, self-linking via `prior_document_id <> document_id` and `superseded_by_document_id <> document_id`, plus useful due-job and document-object-key indexes. Existing pre-migration rows keep null storage keys and remain inaccessible to the new download-grant method because it requires `ACTIVE` plus non-null storage key and released timestamp.

Mirror the logical migration in an isolated Supabase test-profile migration without applying it live.

- [ ] **Step 4: Run migration-contract tests GREEN and commit**

Run: `node --test tests/unit/secure-document-migration-contract.test.js tests/unit/migration-contract.test.js`
Expected: PASS.

Commit: `feat: add secure document lifecycle schema`

---

### Task 3: Provider-neutral storage and scanner contracts

**Files:**
- Create: `services/api/src/document-storage.js`
- Create: `services/api/src/malware-scanner.js`
- Create: `tests/unit/document-storage-contract.test.js`
- Create: `tests/unit/malware-scanner-contract.test.js`

**Interfaces:**
- Produces: `assertDocumentStorage(storage, { production })`
- Produces: `assertMalwareScanner(scanner)`
- Produces deterministic test adapters: `MemoryDocumentStorage`, `ScriptedMalwareScanner`

- [ ] **Step 1: Write contract tests RED**

```js
assert.throws(() => assertDocumentStorage({}, {production:false}), /createUploadGrant/i);
assert.throws(() => assertDocumentStorage(insecureStorage, {production:true}), /private.*encryption/i);
const storage = new MemoryDocumentStorage();
const grant = await storage.createUploadGrant({objectKey:'quarantine/COURT-A/doc-1',contentType:'application/pdf',sizeBytes:5,expiresAt:new Date(Date.now()+60000).toISOString(),encryptionRequired:true});
assert.equal(grant.objectKey,'quarantine/COURT-A/doc-1');
assert.equal(typeof grant.uploadUrl,'string');
```

Scanner test:

```js
const scanner = new ScriptedMalwareScanner([{status:'CLEAN',engine:'fixture',version:'1'}]);
assert.deepEqual(await scanner.scan({objectKey:'q/a'}), {status:'CLEAN',engine:'fixture',version:'1',resultCode:'CLEAN'});
assert.throws(() => assertMalwareScanner({}), /scan/i);
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/document-storage-contract.test.js tests/unit/malware-scanner-contract.test.js`
Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement contracts and deterministic adapters**

`assertDocumentStorage` requires `createUploadGrant`, `headObject`, `createDownloadGrant`, and `capabilities()`. In production capability mode, `capabilities()` must report `{privateObjects:true,encryptionAtRest:true}` or throw before use. `MemoryDocumentStorage` is test/development-only and must identify itself as `developmentOnly:true`; it stores object metadata in memory, not real credentials.

`assertMalwareScanner` requires `scan({objectKey})`. `normalizeScanResult()` accepts only `CLEAN`,`INFECTED`,`UNSUPPORTED`,`ERROR_RETRYABLE`,`ERROR_PERMANENT`; any other value throws a generic scan-result error that callers treat as fail-closed.

- [ ] **Step 4: Run GREEN and commit**

Run: `node --test tests/unit/document-storage-contract.test.js tests/unit/malware-scanner-contract.test.js`
Expected: PASS.

Commit: `feat: add provider-neutral document security adapters`

---

### Task 4: Persistent document repository and durable scan queue

**Files:**
- Modify: `services/api/src/postgres-repository.js`
- Create: `services/api/src/postgres-document-scan-store.js`
- Test: `tests/unit/postgres-secure-document-repository.test.js`
- Test: `tests/unit/postgres-document-scan-store.test.js`

**Interfaces:**
- `PostgresRepository.createDocumentUploadIntent(input)`
- `PostgresRepository.finalizeDocumentAndCreateScanJob(input)`
- `PostgresRepository.getDocument(documentId)` returns new secure fields.
- `PostgresRepository.activateCleanDocument(input)`
- `PostgresRepository.changeDocumentClassification(input)`
- `PostgresRepository.supersedeDocument(input)`
- `PostgresRepository.withdrawDocument(input)`
- `PostgresDocumentScanStore.claimDue({workerId,limit,leaseSeconds,now})`
- `markClean`, `markInfected`, `markRetryableFailure`, `retryDeadLetter`

- [ ] **Step 1: Write repository RED tests**

Use a recording fake queryable and assert parameterized SQL. Required behavior includes upload intent `UPLOAD_PENDING`, server-generated object key persistence, finalization transaction semantics, activation only from quarantined/clean state, and no `DELETE FROM documents.documents` query in the repository API.

Example assertion:

```js
await repo.createDocumentUploadIntent({documentId:'d1',filingId:'f1',courtId:'c1',fileName:'x.pdf',mimeType:'application/pdf',expectedSizeBytes:10,classification:'CONFIDENTIAL',storageObjectKey:'quarantine/c1/d1',actorSubject:'u1'});
assert.match(db.calls[0].sql,/INSERT INTO documents\.documents/i);
assert.match(db.calls[0].sql,/UPLOAD_PENDING/i);
assert.equal(db.calls[0].params.includes('quarantine/c1/d1'),true);
```

- [ ] **Step 2: Run repository tests RED**

Run: `node --test tests/unit/postgres-secure-document-repository.test.js`
Expected: FAIL because methods do not exist.

- [ ] **Step 3: Implement repository mapping/mutations**

Extend `mapDocument()` to include `storageObjectKey`, `versionNumber`, `priorDocumentId`, `supersededByDocumentId`, `expectedSizeBytes`, `detectedMimeType`, `finalizedAt`, `filePolicyResult`, `scanStatus`, `scanResult`, scanner evidence, `releasedAt`, withdrawal and legal-hold fields.

`finalizeDocumentAndCreateScanJob` must require a pool/transaction-capable queryable, `BEGIN`, lock/update only `UPLOAD_PENDING`, set authoritative size/checksum/detected type, `file_policy_result='PASSED'`, `status='QUARANTINED'`, then insert scan job with `ON CONFLICT(document_id) DO NOTHING`, and commit. A conflicting finalization that differs from canonical stored metadata throws code `DOCUMENT_FINALIZE_CONFLICT`; exact replay returns the canonical record.

- [ ] **Step 4: Write scan-store RED tests**

Prove claim SQL contains `FOR UPDATE SKIP LOCKED`, bounded `LIMIT`, lease owner/expiry, due/stale lease conditions, and worker ownership on result updates. Prove retry delay uses deterministic capped exponential schedule and exhaustion transitions `DEAD_LETTER`.

- [ ] **Step 5: Implement scan store**

Use the established outbox-store lease patterns but keep a separate `documents.scan_jobs` table and normalized methods. A worker may update only rows leased to its `workerId`. `retryDeadLetter()` changes only `DEAD_LETTER` to `PENDING`, clears lease/error evidence required for reprocessing, and does not modify document `scan_result` to `CLEAN`.

- [ ] **Step 6: Run Task 4 GREEN and commit**

Run: `node --test tests/unit/postgres-secure-document-repository.test.js tests/unit/postgres-document-scan-store.test.js`
Expected: PASS.

Commit: `feat: persist secure documents and malware scan jobs`

---

### Task 5: Secure document application service — upload/finalize/download/version controls

**Files:**
- Create: `services/api/src/secure-document-service.js`
- Modify: `services/api/src/persistent-dciecms-service.js`
- Modify: `services/api/src/dciecms-service.js`
- Test: `tests/unit/secure-document-service.test.js`
- Modify: `tests/security/document-access.test.js`

**Interfaces:**
- `initiateDocumentUpload(actor, filingId, input)`
- `finalizeDocumentUpload(actor, documentId)`
- `authorizeDocumentDownload(actor, documentId)`
- `changeDocumentClassification(actor, documentId, {classification,reason})`
- `createReplacementDocument(actor, documentId, input)`
- `supersedeDocument(actor, documentId, replacementDocumentId, reason)`
- `withdrawDocument(actor, documentId, reason)`
- `retryDocumentScan(actor, documentId)`

- [ ] **Step 1: Write upload/finalize RED tests**

Use fake repository/storage. Prove:

```js
const initiated = await service.initiateDocumentUpload(regA,'filing-a',{fileName:'claim.pdf',mimeType:'application/pdf',sizeBytes:12,classification:'CONFIDENTIAL'});
assert.match(initiated.objectKey,/^quarantine\/COURT-A\//);
assert.equal(initiated.uploadGrant.uploadUrl.includes('public'),false);
assert.equal(auditJson.includes(initiated.uploadGrant.uploadUrl),false);
```

Caller input containing `objectKey` or `storageUrl` must be ignored/rejected; server generates its own key.

Finalize test sets trusted storage `headObject` to `{sizeBytes:12,checksumSha256:'a'.repeat(64),detectedMimeType:'application/pdf'}` and proves repository receives those values, not caller-provided evidence.

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/secure-document-service.test.js`
Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement upload/finalize service**

`SecureDocumentService` receives `{repository, storage, auditStore, scanStore, clock, uuid}`. It resolves filing access through supplied repository/base-service helpers, validates intent with Task 1 policy, builds object key `quarantine/<courtId>/<documentId>/<sanitized-file-name>` using server-generated IDs, persists intent before issuing grant, and audits only identifiers/metadata.

Finalize loads the intent, calls `headObject` for the stored key, validates authoritative evidence, then calls `finalizeDocumentAndCreateScanJob`. It never accepts checksum/detected type from an HTTP request body.

Keep legacy `registerDocument()` only as compatibility scaffolding for existing tests if necessary, but mark it metadata-only/development and ensure the new HTTP secure flow does not use it. Do not create a production bypass through that method.

- [ ] **Step 4: Write download/classification/version RED tests**

Prove download authorization rejects every non-`ACTIVE` state, requires non-null object key/release time, and for restricted/sealed documents requires explicit grants in addition to base permission/court scope. Prove returned grant is short-lived and audit details do not contain its URL/token.

Prove replacement creates new document/object key and cannot mutate old checksum/object key. Supersede requires same filing lineage and active replacement. Withdrawal requires non-empty reason. There is no `deleteDocument` method.

- [ ] **Step 5: Implement controls and bridge into existing services**

Expose the secure document methods from persistent and in-memory service paths by composition/delegation to one shared secure-document component rather than duplicating policy logic. Existing `getDocument()` continues returning metadata only and must never include a signed URL.

Classification changes require `document.classification.change`; supersede requires `document.supersede`; withdrawal requires `document.withdraw`; retry requires `document.scan.retry`.

- [ ] **Step 6: Run Task 5 GREEN and commit**

Run: `node --test tests/unit/secure-document-service.test.js tests/security/document-access.test.js tests/security/document-classification-rbac.test.js`
Expected: PASS.

Commit: `feat: add secure document upload and retrieval lifecycle`

---

### Task 6: Malware scan worker and clean-only release

**Files:**
- Create: `services/api/src/document-scan-worker.js`
- Test: `tests/unit/document-scan-worker.test.js`
- Test: `tests/security/document-clean-release.test.js`

**Interfaces:**
- `new DocumentScanWorker({scanStore, repository, storage, scanner, auditStore, workerId, clock})`
- `runOnce({limit=10}) -> {claimed,clean,infected,retried,deadLettered}`

- [ ] **Step 1: Write worker RED tests**

Cases:

```js
scanner = new ScriptedMalwareScanner([{status:'CLEAN',engine:'fixture',version:'1'}]);
const result = await worker.runOnce({limit:1});
assert.equal(result.clean,1);
assert.equal(repository.document.status,'ACTIVE');
assert.equal(repository.document.scanResult,'CLEAN');
```

Also prove:

- `INFECTED` -> document `REJECTED`, never `ACTIVE`;
- `UNSUPPORTED`/`ERROR_PERMANENT` -> `REJECTED` or permanent failed scan state, never `ACTIVE`;
- `ERROR_RETRYABLE`/scanner throw/storage fetch failure -> retry or dead letter, document remains `QUARANTINED`;
- malformed scanner status -> fail closed, never activate;
- only the lease owner can complete a job;
- clean activation and audit mutation use the same transaction when provided the existing transaction manager.

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/document-scan-worker.test.js tests/security/document-clean-release.test.js`
Expected: FAIL because worker does not exist.

- [ ] **Step 3: Implement worker**

Algorithm:

```js
const jobs = await scanStore.claimDue({workerId,limit,leaseSeconds:60,now:clock.now()});
for (const job of jobs) {
  try {
    const document = await repository.getDocument(job.documentId);
    if (!document || document.status !== 'QUARANTINED') { await scanStore.markPermanentFailure(...); continue; }
    const normalized = normalizeScanResult(await scanner.scan({objectKey:document.storageObjectKey}));
    if (normalized.status === 'CLEAN') {
      await repository.activateCleanDocument({documentId:document.documentId,scanJobId:job.scanJobId,workerId,scannerEngine:normalized.engine,scannerVersion:normalized.version,releasedAt:clock.now()});
      await auditStore.append({action:'document.release', ...safeIds});
      continue;
    }
    // infected/permanent -> reject; retryable -> bounded retry
  } catch (error) {
    await scanStore.markRetryableFailure({scanJobId:job.scanJobId,workerId,errorCode:'SCAN_UNAVAILABLE',now:clock.now()});
  }
}
```

Do not expose raw scanner exception messages in audit or client-facing state. Unknown status is treated as failure, not success.

- [ ] **Step 4: Run GREEN and commit**

Run: `node --test tests/unit/document-scan-worker.test.js tests/security/document-clean-release.test.js`
Expected: PASS.

Commit: `feat: release documents only after clean malware scan`

---

### Task 7: HTTP boundary, runtime wiring and transaction registry

**Files:**
- Modify: `services/api/src/http-app.js`
- Modify: `services/api/src/runtime-service.js`
- Modify: `services/api/src/transactional-service.js`
- Create: `services/api/src/document-runtime.js`
- Test: `tests/api/secure-document-http.test.js`
- Modify: `tests/unit/runtime-service.test.js`
- Modify: `tests/unit/runtime-transactional-audit.test.js`

**Interfaces:**
- HTTP routes:
  - `POST /filings/:filingId/documents/uploads`
  - `POST /documents/:documentId/finalize`
  - `POST /documents/:documentId/download-authorizations`
  - `POST /documents/:documentId/classification`
  - `POST /documents/:documentId/replacements`
  - `POST /documents/:documentId/supersede`
  - `POST /documents/:documentId/withdraw`
  - `POST /documents/:documentId/retry-scan`

- [ ] **Step 1: Write HTTP RED tests**

Prove initiation returns `201` with document metadata plus ephemeral upload grant, finalize ignores body integrity claims and uses service/storage evidence, download authorization returns ephemeral grant only for eligible document, cross-court/classification failures return sanitized 403, lifecycle conflicts return 409/422 as appropriate, and errors never echo provider/scanner internals.

- [ ] **Step 2: Run RED**

Run: `node --test tests/api/secure-document-http.test.js`
Expected: FAIL with 404/new methods absent.

- [ ] **Step 3: Add HTTP routes and mutation registry**

Add secure routes before generic fallthrough. Add mutation names to `MUTATING_SERVICE_METHODS`:

```js
'initiateDocumentUpload',
'finalizeDocumentUpload',
'changeDocumentClassification',
'createReplacementDocument',
'supersedeDocument',
'withdrawDocument',
'retryDocumentScan'
```

`authorizeDocumentDownload` remains read-like from the business database perspective but its audit write must still be awaited; if transactional audit coupling is required for download authorization, include it explicitly as a mutating/audited operation and test that decision.

- [ ] **Step 4: Wire provider-neutral runtime safely**

`document-runtime.js` exports `createDocumentRuntime({env, storage, scanner, production})`. Development/test may inject `MemoryDocumentStorage` and `ScriptedMalwareScanner`. Production must not silently instantiate development adapters. If secure-document runtime is enabled in production, assert storage capabilities `{privateObjects:true,encryptionAtRest:true}` and require injected/approved production adapters. No credentials are read from committed defaults.

Persistent runtime creates `PostgresDocumentScanStore` over the same transaction-aware database used by repository/audit, and injects the secure document component into the service chain. In-memory runtime uses deterministic development adapters only outside `NODE_ENV=production`.

- [ ] **Step 5: Prove audit transaction coupling**

Add a representative test where a persistent document mutation writes business SQL then audit SQL through one physical client and audit failure rolls back the document mutation. Also prove scan-job insertion failure rolls back finalization.

- [ ] **Step 6: Run Task 7 GREEN and commit**

Run: `npm run test:api && node --test tests/unit/runtime-service.test.js tests/unit/runtime-transactional-audit.test.js`
Expected: PASS.

Commit: `feat: expose secure document pipeline through API runtime`

---

### Task 8: Security regressions, configuration and documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/runbooks/LOCAL_DEVELOPMENT.md`
- Modify: `docs/architecture/IMPLEMENTATION_STATUS.md`
- Create: `tests/security/secure-document-pipeline.test.js`

**Interfaces:**
- No new live provider settings. Example settings remain placeholders/development-safe.

- [ ] **Step 1: Add security regression suite**

Required assertions:

```js
assert.equal(JSON.stringify(documentMetadata).includes('signed-upload-token'), false);
assert.equal(JSON.stringify(auditEvents).includes('signed-download-token'), false);
assert.throws(() => download(quarantined), /not active/i);
assert.throws(() => download(restrictedWithoutGrant), /explicit grant/i);
assert.equal(typeof service.deleteDocument, 'undefined');
```

Also prove arbitrary caller object key is rejected/ignored, clean-only release invariant, scanner exception does not activate, superseded/withdrawn versions cannot receive ordinary grants, legal hold makes disposition ineligible, and no raw provider/scanner secrets appear in sanitized HTTP responses.

- [ ] **Step 2: Run security suite GREEN**

Run: `npm run test:security`
Expected: PASS.

- [ ] **Step 3: Update configuration/docs**

`.env.example` may document only non-secret mode placeholders such as:

```dotenv
# Secure document pipeline development/testing only.
# Production storage/scanner adapters and credentials are intentionally not configured here.
DCIECMS_DOCUMENT_PIPELINE_MODE=development
```

Runbook/README/status must state:

- provider-neutral secure pipeline is repository-delivered;
- private direct upload/download grants are application contracts, not a live provider integration;
- malware worker is provider-neutral and no production scanner is activated;
- migration `0013` is not represented as applied live;
- production object storage/KMS/scanner selection, credentials, worker scheduling and deployment remain outstanding gates.

- [ ] **Step 4: Run full verification and commit**

Run:

```bash
npm test
npm run test:security
npm run test:frontend
npm run build:frontend
```

Expected: all PASS.

Commit: `docs: document secure document production boundary`

---

### Task 9: Exact-diff security review, PR, merge and post-merge verification

**Files:**
- Review every changed file from `main...feat/secure-document-pipeline`.
- No new code unless review finds a defect; any Critical/Important defect gets a failing regression before the fix.

**Interfaces:**
- Final output is a reviewed PR and verified merge; no live deployment.

- [ ] **Step 1: Run fresh exact-head verification**

Run:

```bash
npm test
npm run test:security
npm run test:frontend
npm run build:frontend
```

Expected: all PASS on the exact branch head.

- [ ] **Step 2: Security diff review**

Inspect specifically for:

- public/permanent object URL leakage;
- caller-controlled object keys or cross-court storage paths;
- trusting client checksum/MIME over authoritative evidence;
- any path to `ACTIVE` without exact `CLEAN`;
- scanner/storage outage fail-open;
- administrative scan bypass;
- restricted/sealed bypass of base permission/court scope;
- signed grant/provider/scanner secret leakage to DB/audit/outbox/log/errors;
- mutable finalized object key/checksum;
- hard-delete path or legal-hold disposal bypass;
- scan lease ownership/concurrency defects;
- missing transaction coupling for persistent mutation + audit + scan-job enqueue;
- production fallback to development storage/scanner adapters.

If a Critical/Important defect is found, add a RED test first, prove it fails, implement the smallest fix, rerun full exact-head CI, and re-review the affected diff.

- [ ] **Step 3: Open PR against `main`**

PR title: `feat: secure document pipeline`

PR body must state that it adds provider-neutral quarantine/upload/finalize/scan/release/download/version/classification controls, migration `0013` is repository-only, and no live storage/KMS/scanner credentials, live migration or production deployment are included.

- [ ] **Step 4: Require PR-triggered CI on exact reviewed head**

Do not merge if the PR head changes after review without re-running the gate. Check review threads/comments for unresolved Critical/Important findings.

- [ ] **Step 5: Merge only exact-head green**

Merge PR into `main` only when exact PR head CI is successful and review is clean.

- [ ] **Step 6: Require post-merge `main` CI**

Fetch the `push` workflow for the exact merge commit. Only declare the workstream complete when that exact `main` run concludes `success`.

- [ ] **Step 7: Preserve production gates**

Do not deploy, configure real provider credentials, apply `0013` live, activate scanner/KMS, schedule a production worker or dispose of records as part of this task.