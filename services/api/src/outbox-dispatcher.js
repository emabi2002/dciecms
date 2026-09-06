'use strict';

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function retryDelayMs(attemptNumber, baseDelayMs = 1000, maxDelayMs = 300000) {
  positiveInteger(attemptNumber, 'attemptNumber');
  positiveInteger(baseDelayMs, 'baseDelayMs');
  positiveInteger(maxDelayMs, 'maxDelayMs');
  const exponent = Math.max(0, attemptNumber - 1);
  return Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
}

function asIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Outbox dispatcher clock returned an invalid time');
  return date.toISOString();
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error || '').trim();
  return text || 'Unknown outbox delivery failure';
}

class OutboxDispatcher {
  constructor({
    outboxStore,
    handlers = {},
    workerId,
    batchSize = 25,
    leaseTimeoutMs = 300000,
    maxAttempts = 5,
    baseDelayMs = 1000,
    maxDelayMs = 300000,
    clock = () => new Date()
  } = {}) {
    if (!outboxStore || typeof outboxStore.claimBatch !== 'function' ||
        typeof outboxStore.markDelivered !== 'function' || typeof outboxStore.markFailed !== 'function') {
      throw new TypeError('OutboxDispatcher requires an outbox store with claimBatch(), markDelivered() and markFailed()');
    }
    const normalizedWorkerId = String(workerId || '').trim();
    if (!normalizedWorkerId) throw new TypeError('workerId is required');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new TypeError('batchSize must be an integer between 1 and 100');
    }
    nonNegativeInteger(leaseTimeoutMs, 'leaseTimeoutMs');
    positiveInteger(maxAttempts, 'maxAttempts');
    positiveInteger(baseDelayMs, 'baseDelayMs');
    positiveInteger(maxDelayMs, 'maxDelayMs');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');

    this.outboxStore = outboxStore;
    this.handlers = handlers instanceof Map ? new Map(handlers) : new Map(Object.entries(handlers || {}));
    this.workerId = normalizedWorkerId;
    this.batchSize = batchSize;
    this.leaseTimeoutMs = leaseTimeoutMs;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.clock = clock;
  }

  async runOnce() {
    const claimTime = asIso(this.clock);
    const events = await this.outboxStore.claimBatch({
      workerId: this.workerId,
      limit: this.batchSize,
      now: claimTime,
      leaseTimeoutMs: this.leaseTimeoutMs
    });

    const summary = {
      claimed: events.length,
      delivered: 0,
      retried: 0,
      deadLettered: 0
    };

    for (const event of events) {
      const handler = this.handlers.get(event.eventType);
      let deliveryError = null;

      if (!handler) {
        deliveryError = new Error(`No outbox handler registered for ${event.eventType}`);
      } else {
        try {
          await handler(event);
        } catch (error) {
          deliveryError = error;
        }
      }

      if (!deliveryError) {
        const deliveredAt = asIso(this.clock);
        await this.outboxStore.markDelivered({
          eventId: event.outboxEventId,
          workerId: this.workerId,
          deliveredAt
        });
        summary.delivered += 1;
        continue;
      }

      const attemptedAt = asIso(this.clock);
      const attemptNumber = Number(event.attemptCount || 0) + 1;
      const delayMs = retryDelayMs(attemptNumber, this.baseDelayMs, this.maxDelayMs);
      const nextAttemptAt = new Date(Date.parse(attemptedAt) + delayMs).toISOString();
      const failed = await this.outboxStore.markFailed({
        eventId: event.outboxEventId,
        workerId: this.workerId,
        attemptedAt,
        error: errorMessage(deliveryError),
        nextAttemptAt,
        maxAttempts: this.maxAttempts
      });

      if (failed.status === 'DEAD_LETTER') summary.deadLettered += 1;
      else summary.retried += 1;
    }

    return summary;
  }
}

module.exports = { OutboxDispatcher, retryDelayMs };
