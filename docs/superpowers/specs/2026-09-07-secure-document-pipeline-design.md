# Secure Document Pipeline — Design Specification

Date: 2026-09-07
Status: Approved under user blanket approval for design, specification, implementation planning, TDD implementation, security review, PR and verified merge. Live-production, credential, irreversible database and destructive actions remain excluded.

## 1. Purpose

DCIECMS currently registers document metadata, validates SHA-256 digest syntax, places records in `QUARANTINED`, enforces court-scoped document access, and does not expose a public storage URL. This workstream turns that metadata-only boundary into a provider-neutral secure document pipeline suitable for court records without selecting or activating a production storage or malware-scanning vendor.

The pipeline must protect document bytes from upload through quarantine, validation, malware scanning, technical release, authorized retrieval, version replacement, archival and eventual governed disposal.

## 2. Scope

This workstream delivers repository-level architecture and application behavior for:

- provider-neutral private object storage abstraction;
- server-authorized direct-to-quarantine upload grants;
- upload finalization with immutable storage metadata and byte-integrity evidence;
- strict file type, file signature/content, MIME and size policy validation;
- durable asynchronous malware scan jobs with leases, bounded retries and dead-letter handling;
- recorded scan evidence and clean-only automatic technical release;
- server-enforced document classifications including `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED` and `SEALED`;
- short-lived authorized download grants for eligible active documents;
- immutable document versions with supersede/withdraw lineage;
- audit evidence for sensitive document lifecycle actions;
- no normal application hard-delete;
- legal-hold and governed-disposal data boundaries;
- provider capability requirement for production encryption at rest backed by an approved KMS/HSM or equivalent managed key system;
- fail-closed error handling and tests.

Out of scope for this workstream:

- selecting or activating Supabase Storage, S3, Azure Blob or another production object store;
- supplying production object-store, malware-scanner, KMS/HSM or IdP credentials;
- installing or operating a real malware engine in a production environment;
- browser upload UX beyond provider-neutral API contracts required by the backend;
- applying migrations to a live database;
- destructive disposal of live court records;
- production deployment.

## 3. Architectural principles

### 3.1 Private object storage only

All document objects are private. DCIECMS never stores or returns a permanent public object URL.

The application depends on a provider-neutral `DocumentStorage` contract. A production adapter may later target Supabase Storage, an S3-compatible service, Azure Blob, government-hosted object storage, or another approved provider without changing court workflow semantics.

### 3.2 Server-authorized direct upload

The API remains the policy authority even though large file bytes do not transit through the API server.

Flow:

1. Authenticated actor requests upload initiation for a filing.
2. API validates filing relationship, RBAC/court scope, requested classification, file name, declared type and expected size against policy.
3. API creates a document upload intent and immutable quarantine object key.
4. Storage adapter returns a short-lived single-purpose upload grant bound to that object key and policy constraints supported by the provider.
5. Browser/client uploads directly to private quarantine storage.
6. Client calls finalize.
7. API reads authoritative object metadata from storage and verifies object existence, size, checksum/integrity evidence and content inspection result supplied by trusted server-side inspection components.
8. Only a successful finalization transaction creates or activates the durable scan job.

No caller can supply its own final object key or arbitrary storage URL.

### 3.3 Fail-closed quarantine

A document is not retrievable through the normal court-document path until all technical gates have passed.

Lifecycle states introduced/refined by this workstream:

- `UPLOAD_PENDING` — upload intent exists but finalized bytes are not yet accepted;
- `QUARANTINED` — bytes finalized and waiting for or undergoing security validation/scanning;
- `ACTIVE` — all technical controls passed; ordinary authorization rules may now allow retrieval;
- `REJECTED` — technical validation or malware result permanently disqualified this version from release;
- existing `ARCHIVED`, `SUPERSEDED`, `WITHDRAWN` remain terminal/operational lifecycle states.

A scan timeout, scanner outage, unsupported scan state, inconclusive result or storage inconsistency never releases the document.

## 4. Storage abstraction

`DocumentStorage` must expose behavior equivalent to:

- `createUploadGrant({ objectKey, contentType, sizeBytes, expiresAt, encryptionRequired })`;
- `headObject({ objectKey })` returning provider-authoritative metadata including size and checksum/integrity fields where available;
- `createDownloadGrant({ objectKey, fileName, contentType, expiresAt })`;
- `copyOrPromoteObject(...)` only if the eventual provider requires a physical quarantine-to-active move;
- `deleteObject(...)` only for governed disposal tooling outside normal document workflows.

The application stores an opaque `storage_object_key`, not a provider URL.

Upload and download grant responses are ephemeral and must never be written to audit, outbox, database detail columns or logs.

Production startup must fail if the configured storage adapter cannot attest that objects are private and encryption-at-rest capability is enabled according to approved environment policy.

## 5. File-policy validation

The server owns the allow-list. A client-provided file extension or MIME value is advisory only.

The first implementation defines a configurable policy object with:

- allowed extensions;
- allowed declared MIME types;
- allowed detected content signatures/types;
- extension/MIME/detected-type consistency rules;
- maximum file size;
- prohibited executable/script/archive classes by default.

Initial safe court-document profile supports PDF, DOC/DOCX, XLS/XLSX and common image formats such as JPEG and PNG. ZIP and other archive formats are blocked by default.

The content-inspection boundary is provider-neutral. Tests use controlled fixtures; no external inspection service is required.

A mismatch or prohibited content result marks the version `REJECTED`, records reason-code evidence, and prevents scan/release progression.

## 6. Integrity and immutability

Every finalized version has immutable identity and integrity evidence:

- document ID;
- version ID or version number;
- filing/court relationship;
- immutable storage object key;
- authoritative size;
- SHA-256 checksum;
- detected content type;
- created/finalized timestamps;
- creator/finalizer actor subject.

After finalization, bytes may not be overwritten in place. A replacement creates a new version with a new object key and checksum. The prior version becomes `SUPERSEDED` or may be `WITHDRAWN` through an authorized workflow. Historical bytes and evidence remain retained unless a separately governed disposal process later authorizes physical destruction.

Finalize is idempotent for the same upload intent and canonical object metadata. Conflicting finalize attempts fail closed.

## 7. Malware scanning

### 7.1 Dedicated scan queue

Malware scanning uses a dedicated durable PostgreSQL job queue rather than the generic integration outbox because scanning is a security-control workflow with its own leases, results and release semantics.

Each finalized, file-policy-valid document version creates exactly one canonical scan job in the same database transaction as the finalization state change.

A scan job includes:

- scan job ID;
- document/version ID;
- status (`PENDING`, `LEASED`, `SUCCEEDED`, `FAILED_RETRYABLE`, `DEAD_LETTER`);
- attempt count;
- next-attempt time;
- lease owner and lease expiry;
- scanner engine/provider identifier;
- scanner version/signature-set version where available;
- sanitized result code;
- created/updated/completed timestamps.

Workers claim due jobs in bounded batches using row locking/`SKIP LOCKED` semantics, with stale-lease reclamation.

### 7.2 Scanner abstraction

A provider-neutral `MalwareScanner` contract accepts an opaque object reference or a controlled stream supplied by the storage adapter and returns a normalized result:

- `CLEAN`;
- `INFECTED`;
- `UNSUPPORTED`;
- `ERROR_RETRYABLE`;
- `ERROR_PERMANENT`.

Raw scanner output is not propagated to clients. Sensitive engine diagnostics remain operational evidence only where safe.

### 7.3 Retry and dead letter

Transient errors receive deterministic bounded exponential backoff. The maximum attempt count is configurable and bounded.

Exhaustion moves the job to `DEAD_LETTER`; the document remains `QUARANTINED` and inaccessible. Operational staff may request a new scan attempt through a controlled retry operation, but no user may manually mark the document clean.

Unknown, malformed or unavailable scanner responses fail closed.

## 8. Automatic clean-only release

Technical release occurs automatically only when all of these are true:

- upload finalized successfully;
- authoritative storage object exists;
- integrity/size checks passed;
- file-policy validation passed;
- malware result is exactly `CLEAN` from the trusted scanner boundary;
- current document/version state is still eligible for release;
- no conflicting withdrawal/supersede transition has occurred.

The scan-success state transition and document activation are performed transactionally where the database owns both records.

`ACTIVE` means technically safe for authorized use. It does not mean the filing has passed Registry validation or acceptance.

There is no manual `mark clean`, `force active` or scanner-bypass capability.

## 9. Classification and authorization

Classifications are server-controlled:

- `PUBLIC` — least restrictive classification, but still uses private storage and server authorization;
- `INTERNAL` — authenticated internal court users only;
- `CONFIDENTIAL` — default; ordinary authorized court/filing relationship required;
- `RESTRICTED` — requires normal document permission plus a dedicated explicit authorization grant;
- `SEALED` — strongest control; requires dedicated sealed-document authority plus normal court/record relationship.

The browser cannot downgrade classification. Classification changes require a privileged server-side operation, a non-empty reason, and audit evidence.

The implementation extends RBAC with dedicated permission/grant semantics instead of embedding role names throughout document code. Existing `document.view` remains a prerequisite.

Access to a direct document ID must still enforce court scope and record relationship before classification-specific rules.

## 10. Authorized download

Normal retrieval for document bytes is a two-step server-authorized operation:

1. API loads the authoritative document/version record and enforces authentication, `document.view`, court scope, filing/case relationship, classification rules, lifecycle state, legal-hold restrictions where applicable, and `ACTIVE` status.
2. Storage adapter issues a short-lived download grant for the exact immutable object key.

The grant lifetime is short and configurable with a conservative default (for example, five minutes).

Audit evidence records that an authorization was issued, including actor subject, court, document/version, filing/case context and classification. It never records the signed URL/token itself.

Download authorization for `QUARANTINED`, `REJECTED`, `WITHDRAWN`, `SUPERSEDED` or otherwise ineligible versions fails closed through the ordinary path.

## 11. Versioning, supersede and withdrawal

Replacement does not mutate bytes.

A new version is created from a prior document lineage. Once the new version is technically `ACTIVE`, an authorized supersede operation may atomically mark the prior version `SUPERSEDED` and link `superseded_by_version_id`.

Withdrawal requires dedicated permission, reason and audit evidence. Withdrawing a version prevents ordinary download but preserves bytes and history.

The database must prevent self-supersede, cycles in simple lineage operations, and cross-document/cross-filing version linking.

## 12. Retention, legal hold and disposal boundary

Normal application code has no hard-delete document method.

Records may be marked `ARCHIVED`, `SUPERSEDED` or `WITHDRAWN` without destroying bytes.

The schema includes legal-hold and retention metadata sufficient for future records-management tooling, such as:

- `legal_hold` boolean;
- optional hold reference/reason identifier;
- retention/disposition eligibility timestamp;
- disposition status/evidence fields.

Actual object deletion is outside normal application services and requires a separately governed disposal workflow. It must refuse destruction while legal hold is active.

This workstream does not execute disposal against any live record.

## 13. Encryption at rest and key management

Production storage must support encryption at rest backed by an approved provider-managed or customer-managed KMS/HSM-equivalent key system.

DCIECMS stores no raw encryption keys in source code, database document rows, audit payloads or browser configuration.

The storage adapter exposes capability/configuration evidence sufficient for startup or health validation. Provider-specific key identifiers may be configuration values supplied by the deployment environment later; no live identifiers are committed in this workstream.

`RESTRICTED` and `SEALED` records may later receive stronger provider key policies without changing document-domain interfaces.

## 14. Audit and event evidence

Lifecycle mutations produce application audit evidence within the existing transactional audit boundary where persistent runtime is configured.

Actions include at minimum:

- `document.upload.initiate`;
- `document.upload.finalize`;
- `document.scan.claim` where operationally useful;
- `document.scan.clean`;
- `document.scan.infected`;
- `document.scan.failed`;
- `document.release`;
- `document.download.authorize`;
- `document.classification.change`;
- `document.supersede`;
- `document.withdraw`;
- `document.scan.retry`.

Audit payloads contain identifiers and normalized reason/result codes, not file bytes, signed URLs, scanner secrets or raw provider credentials.

Generic domain events may be emitted later for selected lifecycle transitions, but this workstream does not require external provider notification handlers.

## 15. Database design

A new migration extends the document model and creates scan jobs. The exact SQL may use additive columns/tables rather than rewriting baseline history.

Required durable data includes:

- upload intent/finalization state;
- opaque storage object key;
- version lineage/version number;
- expected and authoritative size/checksum fields;
- detected content type;
- file-policy result/code;
- scan status/result metadata;
- release timestamp;
- classification;
- supersede/withdraw metadata;
- legal-hold/retention metadata;
- durable `documents.scan_jobs` (or equivalent dedicated schema/table) with lease/retry fields and uniqueness per canonical version scan cycle.

Existing records created before this migration remain compatible and default to safe/non-released behavior unless explicitly migrated through a controlled future process.

No live migration is executed by this workstream.

## 16. HTTP/API boundary

Provider-neutral backend endpoints/service operations are introduced for:

- initiate upload;
- finalize upload;
- request authorized download;
- change classification;
- supersede version;
- withdraw version;
- retry dead-letter/failed scan under privileged control.

Scanner-worker operations are application-internal APIs/services, not browser-trusted endpoints. If exposed over HTTP in a future deployment, they require machine authentication outside this workstream.

All external errors are sanitized. Provider URLs, object-store credentials, scanner diagnostics and signed grants are never included in persistent error evidence.

## 17. Failure semantics

The system fails closed when it cannot prove safety.

Examples:

- missing object at finalize -> conflict/validation failure; no scan job;
- size/checksum mismatch -> `REJECTED`; no release;
- content-policy mismatch -> `REJECTED`; no release;
- storage unavailable -> retryable service failure; no release;
- scan infrastructure unavailable -> retry job; document remains quarantined;
- unknown scan result -> failure; no release;
- expired upload/download grant -> caller must request a new grant;
- classification authorization failure -> 403;
- document unavailable outside actor court/record scope -> deny according to existing API policy without leaking sensitive metadata.

## 18. Security invariants

The implementation and review must prove:

1. No public permanent object URLs.
2. Caller cannot choose arbitrary object key or cross-court filing target.
3. Direct upload grants are short-lived and quarantine-only.
4. Finalization trusts provider/server-side evidence, not caller-declared checksum alone.
5. `ACTIVE` is impossible without an exact normalized `CLEAN` result.
6. Scanner outage or malformed result cannot fail open.
7. No administrative bypass marks unscanned content clean.
8. Non-active versions cannot receive normal download grants.
9. Restricted/sealed controls add authorization; they never replace base `document.view`, court scope or record relationship.
10. Signed upload/download grant material is not persisted to audit/outbox/logs.
11. Finalized bytes are immutable; replacement creates a new version.
12. Normal application services cannot hard-delete finalized records.
13. Legal hold prevents governed disposal eligibility.
14. Production storage capability requires private objects and encryption at rest.
15. Scan-job claims are lease-owned, retry-bounded and concurrency-safe.
16. Audit writes remain transactionally coupled to document mutations in persistent runtime where R4 applies.

## 19. Testing strategy

Tests use deterministic in-memory/fake storage and scanner adapters and PostgreSQL-query fakes where appropriate. No external storage, KMS, scanner or IdP is required.

Coverage must include:

- upload initiation authorization, object-key generation and grant expiry;
- file-policy allow/deny/mismatch/size behavior;
- finalize integrity checks and idempotency/conflict behavior;
- scan-job migration contract and repository claim/lease/retry/dead-letter semantics;
- clean-only release and infected/error quarantine behavior;
- scanner unexpected-response fail-closed behavior;
- download grant authorization by lifecycle/classification/court scope;
- restricted/sealed explicit authorization controls;
- no permanent URL or grant-token persistence;
- immutable version replacement, supersede and withdrawal;
- no normal hard-delete API;
- legal-hold disposal guard contract;
- audit coupling regressions for representative document mutations;
- HTTP sanitized error behavior;
- full backend/security/frontend regression suite and frontend build.

## 20. Acceptance criteria

The workstream is complete only when:

- architecture/specification and implementation plan are committed;
- all new behavior is implemented through TDD with observable RED/GREEN evidence for behavior changes;
- migrations are repository-delivered but not applied to a live environment;
- no production provider credentials/configuration are committed;
- the exact final branch head passes full CI;
- full security diff review finds no unresolved Critical/Important defect;
- PR is opened against `main` on the reviewed exact head;
- PR-triggered CI passes on that exact head;
- merge occurs only after the gate is green;
- post-merge `main` CI passes on the exact merge commit.

Only after the post-merge `main` gate succeeds may the Secure Document Pipeline workstream be declared complete.