'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { AccessDeniedError } = require('../../../packages/rbac');
const { ValidationError, NotFoundError } = require('./dciecms-service');
const { FinanceOperationsService } = require('./finance-operations-service');

const CHANNELS = new Set(['EMAIL','SMS']);
const NOTIFICATION_STATUSES = new Set(['QUEUED','SENDING','DELIVERED','FAILED']);
const DELIVERY_OUTCOMES = new Set(['DELIVERED','FAILED']);

function requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new ValidationError(`${label} is required`);
  return text;
}

function normalizeOptionalFilter(value, allowed, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = String(value).trim().toUpperCase();
  if (!allowed.has(normalized)) throw new ValidationError(`Invalid ${label}`);
  return normalized;
}

function notificationIdempotencyKey({ eventType, resourceId, recipient, channel }) {
  const canonical = [
    String(eventType || '').trim().toLowerCase(),
    String(resourceId || '').trim(),
    String(recipient || '').trim().toLowerCase(),
    String(channel || '').trim().toUpperCase()
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

class NotificationService extends FinanceOperationsService {
  constructor({ repository, auditStore, recipientResolver = null } = {}) {
    super({ repository, auditStore });
    this.recipientResolver = recipientResolver;
  }

  async queueNotification(actor, input = {}) {
    const courtId = requireText(input.courtId, 'Court');
    if (!actor?.courtIds?.includes(courtId)) throw new AccessDeniedError(`Access denied outside court scope: ${courtId}`);
    const channel = normalizeOptionalFilter(input.channel, CHANNELS, 'notification channel');
    if (!channel) throw new ValidationError('Notification channel is required');
    const recipient = requireText(input.recipient, 'Recipient');
    const templateCode = requireText(input.templateCode, 'Template code');
    const eventType = requireText(input.eventType, 'Event type');
    const resourceId = requireText(input.resourceId, 'Resource id');
    const idempotencyKey = notificationIdempotencyKey({ eventType, resourceId, recipient, channel });
    const createdAt = new Date().toISOString();
    const row = await this.repository.createNotification({
      notificationId: randomUUID(),
      courtId,
      channel,
      recipient,
      templateCode,
      eventType,
      resourceId,
      idempotencyKey,
      createdBy: actor.userId,
      createdAt
    });
    this._audit(actor, 'notification.queued', 'notification', row.notificationId, { courtId, channel, eventType, resourceId, idempotencyKey });
    return row;
  }

  async _queueWorkflowNotification(actor, event = {}) {
    if (typeof this.recipientResolver !== 'function') return null;
    const target = await this.recipientResolver(event);
    if (!target?.channel || !target?.recipient) return null;
    return this.queueNotification(actor, {
      courtId: event.courtId,
      channel: target.channel,
      recipient: target.recipient,
      templateCode: event.templateCode,
      eventType: event.eventType,
      resourceId: event.resourceId
    });
  }

  async listNotifications(actor, filters = {}) {
    if (!actor?.courtIds?.length) throw new AccessDeniedError('Notification history requires court scope');
    const status = normalizeOptionalFilter(filters.status, NOTIFICATION_STATUSES, 'notification status');
    const channel = normalizeOptionalFilter(filters.channel, CHANNELS, 'notification channel');
    const rows = await this.repository.listNotifications({ courtIds: actor.courtIds, status, channel });
    this._audit(actor, 'notification.history.view', 'notification_queue', actor.courtIds.join(','), { courtIds: actor.courtIds, status, channel });
    return rows;
  }

  async recordDeliveryAttempt(actor, notificationId, result = {}) {
    if (!actor?.isSystem) throw new AccessDeniedError('Delivery state may be recorded only by a system actor');
    const notification = await this.repository.getNotification(notificationId);
    if (!notification) throw new NotFoundError('Notification not found');
    if (actor.courtIds?.length && !actor.courtIds.includes(notification.courtId)) throw new AccessDeniedError(`Access denied outside court scope: ${notification.courtId}`);
    const outcome = normalizeOptionalFilter(result.outcome, DELIVERY_OUTCOMES, 'delivery outcome');
    if (!outcome) throw new ValidationError('Delivery outcome is required');
    const recorded = await this.repository.recordDeliveryAttempt({
      notificationId,
      outcome,
      providerMessageId: result.providerMessageId ? String(result.providerMessageId).trim() : null,
      errorCode: result.errorCode ? String(result.errorCode).trim() : null,
      errorMessage: result.errorMessage ? String(result.errorMessage).trim() : null,
      attemptedAt: new Date().toISOString()
    });
    this._audit(actor, 'notification.delivery_attempt.recorded', 'notification', notificationId, { courtId: notification.courtId, outcome, attemptId: recorded?.attempt?.attemptId || null });
    return recorded;
  }
}

module.exports = { NotificationService, notificationIdempotencyKey, CHANNELS, NOTIFICATION_STATUSES, DELIVERY_OUTCOMES };
