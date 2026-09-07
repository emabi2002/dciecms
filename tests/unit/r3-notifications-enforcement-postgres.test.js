'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PostgresRepository } = require('../../services/api/src/postgres-repository');

const migrationPath = path.join(process.cwd(),'db/migrations/0017_r3_notifications_enforcement.sql');

class CaptureDb {
  constructor(rows = []) { this.rows = rows; this.calls = []; }
  async query(text, params = []) { this.calls.push({ text, params }); return { rows:this.rows }; }
}

test('migration 0017 defines governed notifications and append-only follow-up evidence', () => {
  const sql = fs.readFileSync(migrationPath,'utf8');
  for (const pattern of [
    /CREATE SCHEMA IF NOT EXISTS notifications/i,
    /CREATE TABLE IF NOT EXISTS notifications\.templates/i,
    /CREATE TABLE IF NOT EXISTS notifications\.intents/i,
    /CREATE TABLE IF NOT EXISTS notifications\.delivery_attempts/i,
    /CREATE TABLE IF NOT EXISTS case_mgmt\.follow_up_tasks/i,
    /CREATE TABLE IF NOT EXISTS case_mgmt\.follow_up_events/i,
    /FOR EACH ROW EXECUTE FUNCTION notifications\.prevent_evidence_mutation/i,
    /REVOKE UPDATE, DELETE ON notifications\.delivery_attempts FROM PUBLIC/i,
    /REVOKE UPDATE, DELETE ON case_mgmt\.follow_up_events FROM PUBLIC/i
  ]) assert.match(sql, pattern);
  assert.doesNotMatch(sql,/\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(sql,/\bDELETE\s+FROM\b/i);
});

test('PostgresRepository installs notification and follow-up persistence API', () => {
  const repo = new PostgresRepository(new CaptureDb());
  for (const method of [
    'createNotificationTemplate','listNotificationTemplates','getNotificationTemplate','activateNotificationTemplate','retireNotificationTemplate',
    'createNotificationIntent','listCaseNotificationIntents','listNotificationQueue','claimNotificationIntents',
    'recordNotificationDeliverySuccess','recordNotificationDeliveryFailure',
    'createFollowUpTask','listCaseFollowUps','listOverdueFollowUps','getFollowUpTask',
    'completeFollowUpTask','cancelFollowUpTask','escalateFollowUpTask','recordFollowUpReminder'
  ]) assert.equal(typeof repo[method], 'function', method);
});

test('notification claim uses bounded row leasing with SKIP LOCKED', async () => {
  const db = new CaptureDb([]);
  const repo = new PostgresRepository(db);
  await repo.claimNotificationIntents({ workerId:'worker-1', limit:10, leaseSeconds:60, now:'2026-09-08T00:00:00Z' });
  const {text,params}=db.calls.at(-1);
  assert.match(text,/FOR UPDATE SKIP LOCKED/i);
  assert.match(text,/status='LEASED'/i);
  assert.match(text,/lease_owner/i);
  assert.deepEqual(params.slice(0,3),['2026-09-08T00:00:00.000Z',10,'worker-1']);
});

test('delivery success records append-only attempt and only transitions the leased intent owned by worker', async () => {
  const db = new CaptureDb([]);
  const repo = new PostgresRepository(db);
  await assert.rejects(()=>repo.recordNotificationDeliverySuccess({
    intentId:'intent-1',workerId:'worker-1',providerCode:'SMTP',attemptedAt:'2026-09-08T00:01:00Z'
  }),/notification|lease|ownership|state/i);
  const {text}=db.calls.at(-1);
  assert.match(text,/notifications\.delivery_attempts/i);
  assert.match(text,/status='LEASED'/i);
  assert.match(text,/lease_owner=\$2/i);
  assert.doesNotMatch(text,/recipient_ref\s*=|render_variables\s*=/i);
});

test('follow-up terminal transitions are OPEN-only and append history rather than deleting evidence', async () => {
  const db = new CaptureDb([]);
  const repo = new PostgresRepository(db);
  await assert.rejects(()=>repo.completeFollowUpTask({ taskId:'task-1',actorSubject:'user-1',note:'done',at:'2026-09-08T01:00:00Z' }),/follow-up|state|conflict/i);
  const {text}=db.calls.at(-1);
  assert.match(text,/status='OPEN'/i);
  assert.match(text,/case_mgmt\.follow_up_events/i);
  assert.doesNotMatch(text,/\bDELETE\b/i);
});

test('follow-up reminder is idempotent per task and reminder occurrence', async () => {
  const db = new CaptureDb([]);
  const repo = new PostgresRepository(db);
  await repo.recordFollowUpReminder({ taskId:'task-1', occurrenceKey:'REMINDER:2026-09-08T02:00:00.000Z', at:'2026-09-08T02:00:00Z' });
  const {text}=db.calls.at(-1);
  assert.match(text,/ON CONFLICT \(task_id, occurrence_key\) DO NOTHING/i);
});
