'use strict';

function freezeClone(value) {
  return Object.freeze(JSON.parse(JSON.stringify(value)));
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

const OUTBOX_COLUMNS = `outbox_event_id, event_type, aggregate_type, aggregate_id,
  court_id, actor_subject, correlation_id, deduplication_key, payload, headers,
  status, attempt_count, next_attempt_at, locked_at, locked_by, last_attempt_at,
  last_error, created_at, delivered_at`;

function mapOutboxRow(row) {
  if (!row) return null;
  return freezeClone({
    outboxEventId: row.outbox_event_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    courtId: row.court_id || null,
    actorSubject: row.actor_subject || null,
    correlationId: row.correlation_id || null,
    deduplicationKey: row.deduplication_key,
    payload: parseJson(row.payload, {}),
    headers: parseJson(row.headers, {}),
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    nextAttemptAt: row.next_attempt_at,
    lockedAt: row.locked_at || null,
    lockedBy: row.locked_by || null,
    lastAttemptAt: row.last_attempt_at || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at || null
  });
}

function requiredText(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function isoTime(value, name) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return date.toISOString();
}

function ownershipConflict() {
  const error = new Error('Outbox event is not processing under this worker lease');
  error.code = 'OUTBOX_OWNERSHIP_CONFLICT';
  return error;
}

class PostgresOutboxStore {
  constructor(queryable) {
    if (!queryable || typeof queryable.query !== 'function') {
      throw new TypeError('PostgresOutboxStore requires a pg-compatible queryable');
    }
    this.db = queryable;
  }

  async enqueue(event) {
    const eventType = requiredText(event?.eventType, 'eventType');
    const aggregateType = requiredText(event?.aggregateType, 'aggregateType');
    const aggregateId = requiredText(event?.aggregateId, 'aggregateId');
    const deduplicationKey = requiredText(event?.deduplicationKey, 'deduplicationKey');
    if (!event?.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      throw new TypeError('payload must be an object');
    }
    if (event.headers !== undefined && (!event.headers || typeof event.headers !== 'object' || Array.isArray(event.headers))) {
      throw new TypeError('headers must be an object');
    }

    const params = [
      eventType,
      aggregateType,
      aggregateId,
      event.courtId || null,
      event.actorSubject || null,
      event.correlationId || null,
      deduplicationKey,
      JSON.stringify(event.payload),
      JSON.stringify(event.headers || {})
    ];

    const inserted = await this.db.query(`INSERT INTO integration.outbox_events (
      event_type, aggregate_type, aggregate_id, court_id, actor_subject,
      correlation_id, deduplication_key, payload, headers
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
    ON CONFLICT (event_type, deduplication_key) DO NOTHING
    RETURNING ${OUTBOX_COLUMNS}`, params);

    if (inserted.rows.length === 1) return mapOutboxRow(inserted.rows[0]);

    const existing = await this.db.query(`SELECT ${OUTBOX_COLUMNS}
      FROM integration.outbox_events
      WHERE event_type=$1 AND deduplication_key=$2`, [eventType, deduplicationKey]);
    if (existing.rows.length !== 1) throw new Error('Outbox deduplication record is unavailable');
    return mapOutboxRow(existing.rows[0]);
  }

  async claimBatch({ workerId, limit = 25, now = new Date().toISOString(), leaseTimeoutMs = 300000 } = {}) {
    const owner = requiredText(workerId, 'workerId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer between 1 and 100');
    if (!Number.isInteger(leaseTimeoutMs) || leaseTimeoutMs < 0) throw new TypeError('leaseTimeoutMs must be a non-negative integer');
    const nowIso = isoTime(now, 'now');
    const leaseCutoff = new Date(Date.parse(nowIso) - leaseTimeoutMs).toISOString();

    const result = await this.db.query(`WITH candidates AS (
      SELECT outbox_event_id AS candidate_id
      FROM integration.outbox_events
      WHERE (status='PENDING' AND next_attempt_at <= $1::timestamptz)
         OR (status='PROCESSING' AND locked_at <= $2::timestamptz)
      ORDER BY next_attempt_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $3
    )
    UPDATE integration.outbox_events AS outbox
    SET status='PROCESSING', locked_at=$1::timestamptz, locked_by=$4
    FROM candidates
    WHERE outbox.outbox_event_id=candidates.candidate_id
    RETURNING ${OUTBOX_COLUMNS}`, [nowIso, leaseCutoff, limit, owner]);

    return result.rows.map(mapOutboxRow);
  }

  async markDelivered({ eventId, workerId, deliveredAt = new Date().toISOString() } = {}) {
    const id = requiredText(eventId, 'eventId');
    const owner = requiredText(workerId, 'workerId');
    const at = isoTime(deliveredAt, 'deliveredAt');
    const result = await this.db.query(`UPDATE integration.outbox_events
      SET status='DELIVERED', delivered_at=$3::timestamptz,
          locked_at=NULL, locked_by=NULL, last_error=NULL
      WHERE outbox_event_id=$1 AND status='PROCESSING' AND locked_by=$2
      RETURNING ${OUTBOX_COLUMNS}`, [id, owner, at]);
    if (result.rows.length !== 1) throw ownershipConflict();
    return mapOutboxRow(result.rows[0]);
  }

  async markFailed({ eventId, workerId, attemptedAt = new Date().toISOString(), error, nextAttemptAt, maxAttempts = 5 } = {}) {
    const id = requiredText(eventId, 'eventId');
    const owner = requiredText(workerId, 'workerId');
    const attempted = isoTime(attemptedAt, 'attemptedAt');
    const message = requiredText(error, 'error');
    const retryAt = isoTime(nextAttemptAt, 'nextAttemptAt');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');

    const result = await this.db.query(`UPDATE integration.outbox_events
      SET attempt_count=attempt_count+1,
          last_attempt_at=$3::timestamptz,
          last_error=$4,
          status=CASE WHEN attempt_count+1 >= $6 THEN 'DEAD_LETTER' ELSE 'PENDING' END,
          next_attempt_at=CASE WHEN attempt_count+1 >= $6 THEN next_attempt_at ELSE $5::timestamptz END,
          locked_at=NULL,
          locked_by=NULL
      WHERE outbox_event_id=$1 AND status='PROCESSING' AND locked_by=$2
      RETURNING ${OUTBOX_COLUMNS}`, [id, owner, attempted, message, retryAt, maxAttempts]);
    if (result.rows.length !== 1) throw ownershipConflict();
    return mapOutboxRow(result.rows[0]);
  }

  async list(filter = {}) {
    const clauses = [];
    const params = [];
    const mapping = [
      ['eventType', 'event_type'],
      ['aggregateType', 'aggregate_type'],
      ['aggregateId', 'aggregate_id'],
      ['courtId', 'court_id'],
      ['status', 'status'],
      ['correlationId', 'correlation_id']
    ];

    for (const [key, column] of mapping) {
      if (filter[key] !== undefined) {
        params.push(filter[key]);
        clauses.push(`${column}=$${params.length}`);
      }
    }

    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.db.query(`SELECT ${OUTBOX_COLUMNS}
      FROM integration.outbox_events${where}
      ORDER BY created_at ASC`, params);
    return result.rows.map(mapOutboxRow);
  }
}

module.exports = { PostgresOutboxStore, mapOutboxRow };
