'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresOutboxStore } = require('../../services/api/src/postgres-outbox-store');

const COURT_A = '11111111-1111-1111-1111-111111111111';

class FakeQueryable {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }

  async query(text, params = []) {
    this.calls.push({ text, params });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return next || { rows: [] };
  }
}

function outboxRow(overrides = {}) {
  return {
    outbox_event_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    event_type: 'filing.accepted',
    aggregate_type: 'filing',
    aggregate_id: 'filing-1',
    court_id: COURT_A,
    actor_subject: 'regmgr-a',
    correlation_id: 'corr-1',
    deduplication_key: 'filing-1',
    payload: { filingId: 'filing-1', status: 'ACCEPTED' },
    headers: {},
    status: 'PENDING',
    attempt_count: 0,
    next_attempt_at: '2026-09-06T00:00:00.000Z',
    locked_at: null,
    locked_by: null,
    last_error: null,
    created_at: '2026-09-06T00:00:00.000Z',
    delivered_at: null,
    ...overrides
  };
}

function enqueueInput() {
  return {
    eventType: 'filing.accepted',
    aggregateType: 'filing',
    aggregateId: 'filing-1',
    courtId: COURT_A,
    actorSubject: 'regmgr-a',
    correlationId: 'corr-1',
    deduplicationKey: 'filing-1',
    payload: { filingId: 'filing-1', status: 'ACCEPTED' },
    headers: {}
  };
}

test('PostgresOutboxStore idempotently enqueues a server event with parameterized SQL', async () => {
  const db = new FakeQueryable([{ rows: [outboxRow()] }]);
  const store = new PostgresOutboxStore(db);

  const record = await store.enqueue(enqueueInput());

  assert.equal(Object.isFrozen(record), true);
  assert.equal(record.eventType, 'filing.accepted');
  assert.equal(record.deduplicationKey, 'filing-1');
  assert.deepEqual(record.payload, { filingId: 'filing-1', status: 'ACCEPTED' });
  assert.match(db.calls[0].text, /INSERT INTO integration\.outbox_events/i);
  assert.match(db.calls[0].text, /ON CONFLICT\s*\(\s*event_type\s*,\s*deduplication_key\s*\)\s*DO NOTHING/i);
  assert.equal(db.calls[0].text.includes('filing.accepted'), false);
  assert.equal(db.calls[0].params.includes('filing.accepted'), true);
});

test('PostgresOutboxStore returns the canonical existing row on duplicate enqueue', async () => {
  const existing = outboxRow({ created_at: '2026-09-05T23:59:00.000Z' });
  const db = new FakeQueryable([{ rows: [] }, { rows: [existing] }]);
  const store = new PostgresOutboxStore(db);

  const record = await store.enqueue(enqueueInput());

  assert.equal(record.createdAt, existing.created_at);
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[1].text, /SELECT[\s\S]+FROM integration\.outbox_events/i);
  assert.deepEqual(db.calls[1].params, ['filing.accepted', 'filing-1']);
});

test('PostgresOutboxStore claims due or stale events with SKIP LOCKED and worker lease ownership', async () => {
  const claimed = outboxRow({
    status: 'PROCESSING',
    locked_at: '2026-09-06T01:00:00.000Z',
    locked_by: 'worker-a'
  });
  const db = new FakeQueryable([{ rows: [claimed] }]);
  const store = new PostgresOutboxStore(db);

  const rows = await store.claimBatch({
    workerId: 'worker-a',
    limit: 25,
    now: '2026-09-06T01:00:00.000Z',
    leaseTimeoutMs: 300000
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].lockedBy, 'worker-a');
  assert.match(db.calls[0].text, /FOR UPDATE SKIP LOCKED/i);
  assert.match(db.calls[0].text, /status='PENDING'[\s\S]+next_attempt_at/i);
  assert.match(db.calls[0].text, /status='PROCESSING'[\s\S]+locked_at/i);
  assert.match(db.calls[0].text, /SET status='PROCESSING'/i);
  assert.equal(db.calls[0].params[2], 25);
  assert.equal(db.calls[0].params[3], 'worker-a');
  assert.equal(db.calls[0].params[0], '2026-09-06T01:00:00.000Z');
  assert.equal(db.calls[0].params[1], '2026-09-06T00:55:00.000Z');
});

test('PostgresOutboxStore marks delivery only for the worker that owns the processing lease', async () => {
  const delivered = outboxRow({
    status: 'DELIVERED',
    attempt_count: 0,
    delivered_at: '2026-09-06T01:01:00.000Z'
  });
  const db = new FakeQueryable([{ rows: [delivered] }, { rows: [] }]);
  const store = new PostgresOutboxStore(db);

  const record = await store.markDelivered({
    eventId: delivered.outbox_event_id,
    workerId: 'worker-a',
    deliveredAt: delivered.delivered_at
  });
  assert.equal(record.status, 'DELIVERED');
  assert.match(db.calls[0].text, /status='PROCESSING'\s+AND\s+locked_by=\$2/i);
  assert.match(db.calls[0].text, /SET status='DELIVERED'/i);

  await assert.rejects(
    () => store.markDelivered({
      eventId: delivered.outbox_event_id,
      workerId: 'worker-b',
      deliveredAt: delivered.delivered_at
    }),
    error => error && error.code === 'OUTBOX_OWNERSHIP_CONFLICT'
  );
});

test('PostgresOutboxStore records a retry and dead-letters at the configured attempt limit', async () => {
  const retryRow = outboxRow({
    status: 'PENDING',
    attempt_count: 1,
    next_attempt_at: '2026-09-06T01:02:00.000Z',
    last_error: 'temporary provider failure'
  });
  const deadRow = outboxRow({
    status: 'DEAD_LETTER',
    attempt_count: 3,
    last_error: 'permanent failure'
  });
  const db = new FakeQueryable([{ rows: [retryRow] }, { rows: [deadRow] }]);
  const store = new PostgresOutboxStore(db);

  const retry = await store.markFailed({
    eventId: retryRow.outbox_event_id,
    workerId: 'worker-a',
    attemptedAt: '2026-09-06T01:01:00.000Z',
    error: 'temporary provider failure',
    nextAttemptAt: retryRow.next_attempt_at,
    maxAttempts: 3
  });
  assert.equal(retry.status, 'PENDING');
  assert.equal(retry.attemptCount, 1);
  assert.match(db.calls[0].text, /attempt_count\s*=\s*attempt_count\s*\+\s*1/i);
  assert.match(db.calls[0].text, /DEAD_LETTER/i);
  assert.match(db.calls[0].text, /locked_by=\$2/i);

  const dead = await store.markFailed({
    eventId: deadRow.outbox_event_id,
    workerId: 'worker-a',
    attemptedAt: '2026-09-06T01:03:00.000Z',
    error: 'permanent failure',
    nextAttemptAt: '2026-09-06T01:10:00.000Z',
    maxAttempts: 3
  });
  assert.equal(dead.status, 'DEAD_LETTER');
  assert.equal(dead.attemptCount, 3);
});

test('PostgresOutboxStore lists exact-match outbox evidence with parameterized filters', async () => {
  const db = new FakeQueryable([{ rows: [outboxRow()] }]);
  const store = new PostgresOutboxStore(db);

  const rows = await store.list({
    eventType: 'filing.accepted',
    aggregateType: 'filing',
    aggregateId: 'filing-1',
    courtId: COURT_A,
    status: 'PENDING',
    correlationId: 'corr-1'
  });

  assert.equal(rows.length, 1);
  assert.match(db.calls[0].text, /FROM integration\.outbox_events/i);
  assert.deepEqual(db.calls[0].params, [
    'filing.accepted',
    'filing',
    'filing-1',
    COURT_A,
    'PENDING',
    'corr-1'
  ]);
});
