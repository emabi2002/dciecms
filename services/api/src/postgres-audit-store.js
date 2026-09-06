'use strict';
const { randomUUID } = require('node:crypto');

function freezeClone(value) {
  return Object.freeze(JSON.parse(JSON.stringify(value)));
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function mapAuditRow(row) {
  if (!row) return null;
  return freezeClone({
    auditEventId: row.audit_event_id,
    eventTime: row.event_time,
    actorUserId: row.actor_subject || row.actor_user_id || null,
    effectiveRoles: parseJson(row.effective_roles, []),
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id || null,
    courtId: row.court_id || null,
    correlationId: row.correlation_id || null,
    reason: row.reason || null,
    approvalReference: row.approval_reference || null,
    details: parseJson(row.details, {})
  });
}

class PostgresAuditStore {
  constructor(queryable) {
    if (!queryable || typeof queryable.query !== 'function') throw new TypeError('PostgresAuditStore requires a pg-compatible queryable');
    this.db = queryable;
  }

  async append(event) {
    if (!event?.actorUserId) throw new Error('Audit actorUserId is required');
    if (!event?.action) throw new Error('Audit action is required');
    if (!event?.resourceType) throw new Error('Audit resourceType is required');

    const {
      actorUserId,
      effectiveRoles = [],
      action,
      resourceType,
      resourceId = null,
      courtId = null,
      correlationId = null,
      reason = null,
      approvalReference = null,
      details: explicitDetails = {},
      ...contextDetails
    } = event;
    const details = {
      ...contextDetails,
      ...(explicitDetails && typeof explicitDetails === 'object' && !Array.isArray(explicitDetails) ? explicitDetails : {})
    };

    const record = freezeClone({
      auditEventId: randomUUID(),
      eventTime: new Date().toISOString(),
      actorUserId,
      effectiveRoles,
      action,
      resourceType,
      resourceId,
      courtId,
      correlationId,
      reason,
      approvalReference,
      details
    });

    await this.db.query(`INSERT INTO audit.audit_events (
      audit_event_id, event_time, actor_subject, effective_roles, action,
      resource_type, resource_id, court_id, correlation_id, reason,
      approval_reference, details
    ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`, [
      record.auditEventId,
      record.eventTime,
      record.actorUserId,
      JSON.stringify(record.effectiveRoles),
      record.action,
      record.resourceType,
      record.resourceId,
      record.courtId,
      record.correlationId,
      record.reason,
      record.approvalReference,
      JSON.stringify(record.details)
    ]);

    return record;
  }

  async list(filter = {}) {
    const clauses = [];
    const params = [];
    const mapping = [
      ['actorUserId', 'actor_subject'],
      ['action', 'action'],
      ['resourceType', 'resource_type'],
      ['resourceId', 'resource_id'],
      ['courtId', 'court_id'],
      ['correlationId', 'correlation_id']
    ];

    for (const [key, column] of mapping) {
      if (filter[key] !== undefined) {
        params.push(filter[key]);
        clauses.push(`${column}=$${params.length}`);
      }
    }

    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.db.query(`SELECT audit_event_id, event_time, actor_subject, actor_user_id,
      effective_roles, action, resource_type, resource_id, court_id, correlation_id,
      reason, approval_reference, details
      FROM audit.audit_events${where}
      ORDER BY event_time ASC`, params);

    return result.rows.map(mapAuditRow);
  }
}

module.exports = { PostgresAuditStore, mapAuditRow };
