'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { createRuntimeService } = require('../../services/api/src/runtime-service');
const { MemoryDocumentStorage } = require('../../services/api/src/document-storage');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const actor = resolveActorFromClaims({ sub: 'reg-a', roles: ['REG'], court_ids: [COURT_A] });
const documentManager = resolveActorFromClaims({ sub: 'reg-mgr-a', roles: ['REG-MGR'], court_ids: [COURT_A] });

function poolFixture({ failAudit = false } = {}) {
  let instance = null;

  class FakePool {
    constructor(options) {
      this.options = options;
      this.calls = [];
      instance = this;
      this.client = {
        query: async (text, params = []) => {
          this.calls.push({ target: 'client', text, params });
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
          if (/INSERT INTO case_mgmt\.parties/i.test(text)) {
            return {
              rows: [{
                party_id: params[0],
                court_id: params[1],
                party_type: params[2],
                display_name: params[3],
                created_at: '2026-09-06T00:00:00.000Z'
              }]
            };
          }
          if (/INSERT INTO audit\.audit_events/i.test(text)) {
            if (failAudit) throw new Error('audit insert failed');
            return { rows: [] };
          }
          throw new Error(`Unexpected client SQL: ${text}`);
        },
        release: () => this.calls.push({ target: 'client', text: 'RELEASE', params: [] })
      };
    }

    async connect() {
      this.calls.push({ target: 'pool', text: 'CONNECT', params: [] });
      return this.client;
    }

    async query(text) {
      this.calls.push({ target: 'pool', text, params: [] });
      throw new Error('Business and audit SQL must not bypass the transaction client');
    }
  }

  return { PoolClass: FakePool, getInstance: () => instance };
}

function secureDocumentPoolFixture({ failAudit = false, failScanInsert = false, status = 'ACTIVE' } = {}) {
  let instance = null;
  const objectKey = `quarantine/${COURT_A}/D-1/claim.pdf`;
  const baseDocument = {
    document_id: 'D-1',
    filing_id: 'F-1',
    court_id: COURT_A,
    file_name: 'claim.pdf',
    mime_type: 'application/pdf',
    size_bytes: status === 'UPLOAD_PENDING' ? 0 : 12,
    checksum_sha256: status === 'UPLOAD_PENDING' ? null : 'a'.repeat(64),
    status,
    classification: 'CONFIDENTIAL',
    created_at: '2026-09-07T00:00:00.000Z',
    storage_object_key: objectKey,
    version_number: 1,
    prior_document_id: null,
    superseded_by_document_id: null,
    expected_size_bytes: 12,
    detected_mime_type: status === 'UPLOAD_PENDING' ? null : 'application/pdf',
    created_by_subject: 'reg-a',
    finalized_at: status === 'UPLOAD_PENDING' ? null : '2026-09-07T00:01:00.000Z',
    finalized_by_subject: status === 'UPLOAD_PENDING' ? null : 'reg-a',
    file_policy_result: status === 'UPLOAD_PENDING' ? 'NOT_CHECKED' : 'PASSED',
    file_policy_code: null,
    scan_status: status === 'UPLOAD_PENDING' ? 'NOT_REQUESTED' : 'CLEAN',
    scan_result: status === 'UPLOAD_PENDING' ? null : 'CLEAN',
    scanner_engine: null,
    scanner_version: null,
    released_at: status === 'ACTIVE' ? '2026-09-07T00:02:00.000Z' : null,
    withdrawn_at: null,
    withdrawn_by_subject: null,
    withdrawal_reason: null,
    legal_hold: false,
    legal_hold_reference: null,
    disposition_eligible_at: null
  };

  class FakePool {
    constructor(options) {
      this.options = options;
      this.calls = [];
      instance = this;
      this.client = {
        query: async (text, params = []) => {
          this.calls.push({ target: 'client', text, params });
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
          if (/SELECT[\s\S]+FROM documents\.documents WHERE document_id=\$1/i.test(text)) {
            return { rows: [{ ...baseDocument }] };
          }
          if (/SELECT[\s\S]+FROM registry\.filings WHERE filing_id = \$1/i.test(text)) {
            return {
              rows: [{
                filing_id: 'F-1',
                filing_reference: 'F-1',
                court_id: COURT_A,
                case_type_code: 'CIV',
                filer_party_id: null,
                status: 'DRAFT',
                created_by: 'reg-a',
                created_at: '2026-09-07T00:00:00.000Z',
                submitted_at: null,
                validated_at: null,
                validated_by_subject: null,
                decision_reason: null,
                decision_by_subject: null,
                decision_at: null
              }]
            };
          }
          if (/UPDATE documents\.documents[\s\S]+SET classification=\$2/i.test(text)) {
            return { rows: [{ ...baseDocument, classification: params[1] }] };
          }
          if (/UPDATE documents\.documents[\s\S]+SET size_bytes=\$2/i.test(text)) {
            return {
              rows: [{
                ...baseDocument,
                size_bytes: params[1],
                checksum_sha256: params[2],
                detected_mime_type: params[3],
                finalized_at: params[4],
                finalized_by_subject: params[5],
                file_policy_result: 'PASSED',
                scan_status: 'PENDING',
                scan_result: null,
                status: 'QUARANTINED'
              }]
            };
          }
          if (/INSERT INTO documents\.scan_jobs/i.test(text)) {
            if (failScanInsert) throw new Error('scan job insert failed');
            return { rows: [] };
          }
          if (/INSERT INTO audit\.audit_events/i.test(text)) {
            if (failAudit) throw new Error('document audit insert failed');
            return { rows: [] };
          }
          throw new Error(`Unexpected secure-document SQL: ${text}`);
        },
        release: () => this.calls.push({ target: 'client', text: 'RELEASE', params: [] })
      };
    }

    async connect() {
      this.calls.push({ target: 'pool', text: 'CONNECT', params: [] });
      return this.client;
    }

    async query(text) {
      this.calls.push({ target: 'pool', text, params: [] });
      throw new Error('Secure document SQL must not bypass the transaction client');
    }
  }

  return { PoolClass: FakePool, getInstance: () => instance, objectKey };
}

test('PostgreSQL runtime commits business mutation and audit evidence on the same physical client', async () => {
  const fixture = poolFixture();
  const service = createRuntimeService({
    env: { DATABASE_URL: 'postgres://example/db' },
    PoolClass: fixture.PoolClass
  });

  const party = await service.createParty(actor, {
    courtId: COURT_A,
    partyType: 'PERSON',
    displayName: 'Jane Doe'
  });

  assert.equal(party.displayName, 'Jane Doe');
  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => call.text === 'BEGIN').length, 1);
  assert.equal(calls.filter(call => call.text === 'COMMIT').length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 0);
  assert.equal(calls.filter(call => /INSERT INTO case_mgmt\.parties/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.target === 'pool' && /INSERT|UPDATE|DELETE/i.test(call.text)).length, 0);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('PostgreSQL runtime rolls back a completed business SQL mutation when its audit insert fails', async () => {
  const fixture = poolFixture({ failAudit: true });
  const service = createRuntimeService({
    env: { DATABASE_URL: 'postgres://example/db' },
    PoolClass: fixture.PoolClass
  });

  await assert.rejects(
    () => service.createParty(actor, {
      courtId: COURT_A,
      partyType: 'PERSON',
      displayName: 'Jane Doe'
    }),
    /audit insert failed/
  );

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /INSERT INTO case_mgmt\.parties/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('secure document mutation and audit evidence share the outer transaction and audit failure rolls back', async () => {
  const fixture = secureDocumentPoolFixture({ failAudit: true });
  const service = createRuntimeService({
    env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://example/db' },
    PoolClass: fixture.PoolClass
  });

  await assert.rejects(
    () => service.changeDocumentClassification(documentManager, 'D-1', {
      classification: 'INTERNAL',
      reason: 'Court direction'
    }),
    /document audit insert failed/
  );

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /UPDATE documents\.documents[\s\S]+SET classification/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO audit\.audit_events/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.filter(call => call.target === 'pool' && /INSERT|UPDATE|DELETE/i.test(call.text)).length, 0);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

test('document finalization rolls back authoritative document mutation when scan-job insertion fails', async () => {
  const fixture = secureDocumentPoolFixture({ failScanInsert: true, status: 'UPLOAD_PENDING' });
  const storage = new MemoryDocumentStorage();
  storage.putObjectMetadata({
    objectKey: fixture.objectKey,
    sizeBytes: 12,
    checksumSha256: 'b'.repeat(64),
    detectedMimeType: 'application/pdf'
  });
  const service = createRuntimeService({
    env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://example/db' },
    PoolClass: fixture.PoolClass,
    documentStorage: storage
  });

  await assert.rejects(
    () => service.finalizeDocumentUpload(documentManager, 'D-1'),
    /scan job insert failed/
  );

  const calls = fixture.getInstance().calls;
  assert.equal(calls.filter(call => /UPDATE documents\.documents[\s\S]+SET size_bytes/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => /INSERT INTO documents\.scan_jobs/i.test(call.text)).length, 1);
  assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.text === 'COMMIT'), false);
  assert.equal(calls.filter(call => call.target === 'pool' && /INSERT|UPDATE|DELETE/i.test(call.text)).length, 0);
  assert.equal(calls.at(-1).text, 'RELEASE');
});
