'use strict';
const { randomUUID } = require('node:crypto');
const { FinanceOperationsPostgresRepository } = require('./finance-operations-postgres-repository');

const NOTIFICATION_COLUMNS = `notification_id,court_id,channel,recipient,template_code,event_type,resource_id,idempotency_key,status,created_by_subject,created_at,last_attempt_at,delivered_at`;
const ATTEMPT_COLUMNS = `attempt_id,notification_id,outcome,provider_message_id,error_code,error_message,attempted_at`;

function mapNotification(row) {
  if (!row) return null;
  return Object.freeze({
    notificationId: row.notification_id,
    courtId: row.court_id,
    channel: row.channel,
    recipient: row.recipient,
    templateCode: row.template_code,
    eventType: row.event_type,
    resourceId: row.resource_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    createdBy: row.created_by_subject,
    createdAt: row.created_at,
    lastAttemptAt: row.last_attempt_at || null,
    deliveredAt: row.delivered_at || null
  });
}

function mapDeliveryAttempt(row) {
  if (!row) return null;
  return Object.freeze({
    attemptId: row.attempt_id,
    notificationId: row.notification_id,
    outcome: row.outcome,
    providerMessageId: row.provider_message_id || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    attemptedAt: row.attempted_at
  });
}

class NotificationPostgresRepository extends FinanceOperationsPostgresRepository {
  async createNotification({ notificationId, courtId, channel, recipient, templateCode, eventType, resourceId, idempotencyKey, createdBy, createdAt }) {
    const result = await this.db.query(
      `WITH inserted AS (
         INSERT INTO notifications.notifications
           (notification_id,court_id,channel,recipient,template_code,event_type,resource_id,idempotency_key,status,created_by_subject,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED',$9,$10)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${NOTIFICATION_COLUMNS}
       )
       SELECT ${NOTIFICATION_COLUMNS} FROM inserted
       UNION ALL
       SELECT ${NOTIFICATION_COLUMNS} FROM notifications.notifications WHERE idempotency_key=$8
       LIMIT 1`,
      [notificationId, courtId, channel, recipient, templateCode, eventType, resourceId, idempotencyKey, createdBy, createdAt]
    );
    return mapNotification(result.rows[0]);
  }

  async listNotifications({ courtIds, status = null, channel = null }) {
    const clauses = ['court_id = ANY($1::uuid[])'];
    const params = [courtIds];
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    if (channel) { params.push(channel); clauses.push(`channel = $${params.length}`); }
    const result = await this.db.query(
      `SELECT ${NOTIFICATION_COLUMNS}
       FROM notifications.notifications
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, notification_id`,
      params
    );
    return result.rows.map(mapNotification);
  }

  async getNotification(notificationId) {
    const result = await this.db.query(
      `SELECT ${NOTIFICATION_COLUMNS}
       FROM notifications.notifications
       WHERE notification_id=$1`,
      [notificationId]
    );
    return mapNotification(result.rows[0]);
  }

  async recordDeliveryAttempt({ notificationId, outcome, providerMessageId, errorCode, errorMessage, attemptedAt }) {
    if (typeof this.db.connect !== 'function') throw new TypeError('recordDeliveryAttempt requires a pool with connect()');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query(
        `SELECT ${NOTIFICATION_COLUMNS}
         FROM notifications.notifications
         WHERE notification_id=$1
         FOR UPDATE`,
        [notificationId]
      );
      if (currentResult.rows.length !== 1) {
        const error = new Error('Notification not found');
        error.code = 'NOTIFICATION_NOT_FOUND';
        throw error;
      }
      const current = currentResult.rows[0];
      if (!['QUEUED','FAILED'].includes(current.status)) {
        const error = new Error('Notification is not dispatchable');
        error.code = 'NOTIFICATION_STATE_CONFLICT';
        throw error;
      }
      const sending = await client.query(
        `UPDATE notifications.notifications
         SET status='SENDING', last_attempt_at=$2
         WHERE notification_id=$1 AND status IN ('QUEUED','FAILED')
         RETURNING notification_id`,
        [notificationId, attemptedAt]
      );
      if (sending.rows.length !== 1) {
        const error = new Error('Notification state changed');
        error.code = 'NOTIFICATION_STATE_CONFLICT';
        throw error;
      }
      const attemptId = randomUUID();
      const attemptResult = await client.query(
        `INSERT INTO notifications.delivery_attempts
          (attempt_id,notification_id,outcome,provider_message_id,error_code,error_message,attempted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING ${ATTEMPT_COLUMNS}`,
        [attemptId, notificationId, outcome, providerMessageId || null, errorCode || null, errorMessage || null, attemptedAt]
      );
      const finalStatus = outcome === 'DELIVERED' ? 'DELIVERED' : 'FAILED';
      const deliveredAt = outcome === 'DELIVERED' ? attemptedAt : null;
      const finalResult = await client.query(
        `UPDATE notifications.notifications
         SET status=$2, last_attempt_at=$3, delivered_at=$4
         WHERE notification_id=$1 AND status='SENDING'
         RETURNING ${NOTIFICATION_COLUMNS}`,
        [notificationId, finalStatus, attemptedAt, deliveredAt]
      );
      if (finalResult.rows.length !== 1) {
        const error = new Error('Notification final state transition failed');
        error.code = 'NOTIFICATION_STATE_CONFLICT';
        throw error;
      }
      await client.query('COMMIT');
      return Object.freeze({ notification: mapNotification(finalResult.rows[0]), attempt: mapDeliveryAttempt(attemptResult.rows[0]) });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { NotificationPostgresRepository, mapNotification, mapDeliveryAttempt };
