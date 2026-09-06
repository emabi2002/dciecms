'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OutboxDispatcher, retryDelayMs } = require('../../services/api/src/outbox-dispatcher');

function event(overrides = {}) {
  return Object.freeze({
    outboxEventId: 'event-1',
    eventType: 'filing.accepted',
    aggregateType: 'filing',
    aggregateId: 'filing-1',
    status: 'PROCESSING',
    attemptCount: 0,
    payload: { filingId: 'filing-1' },
    ...overrides
  });
}

function fixedClock(iso) {
  return () => new Date(iso);
}

test('retryDelayMs uses capped exponential backoff by delivery attempt number', () => {
  assert.equal(retryDelayMs(1, 1000, 10000), 1000);
  assert.equal(retryDelayMs(2, 1000, 10000), 2000);
  assert.equal(retryDelayMs(4, 1000, 5000), 5000);
});

test('OutboxDispatcher marks a successfully handled event delivered', async () => {
  const handled = [];
  const delivered = [];
  const store = {
    async claimBatch(input) {
      assert.deepEqual(input, {
        workerId: 'worker-a',
        limit: 10,
        now: '2026-09-06T02:00:00.000Z',
        leaseTimeoutMs: 300000
      });
      return [event()];
    },
    async markDelivered(input) {
      delivered.push(input);
      return event({ status: 'DELIVERED', deliveredAt: input.deliveredAt });
    },
    async markFailed() { throw new Error('markFailed must not run'); }
  };
  const dispatcher = new OutboxDispatcher({
    outboxStore: store,
    handlers: {
      'filing.accepted': async record => handled.push(record.outboxEventId)
    },
    workerId: 'worker-a',
    batchSize: 10,
    clock: fixedClock('2026-09-06T02:00:00.000Z')
  });

  const result = await dispatcher.runOnce();

  assert.deepEqual(handled, ['event-1']);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    eventId: 'event-1',
    workerId: 'worker-a',
    deliveredAt: '2026-09-06T02:00:00.000Z'
  });
  assert.deepEqual(result, { claimed: 1, delivered: 1, retried: 0, deadLettered: 0 });
});

test('OutboxDispatcher records handler failure with deterministic retry time and continues', async () => {
  const failures = [];
  const store = {
    async claimBatch() { return [event()]; },
    async markDelivered() { throw new Error('delivery must not be marked successful'); },
    async markFailed(input) {
      failures.push(input);
      return event({ status: 'PENDING', attemptCount: 1, lastError: input.error });
    }
  };
  const dispatcher = new OutboxDispatcher({
    outboxStore: store,
    handlers: {
      'filing.accepted': async () => { throw new Error('provider unavailable'); }
    },
    workerId: 'worker-a',
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    clock: fixedClock('2026-09-06T02:00:00.000Z')
  });

  const result = await dispatcher.runOnce();

  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], {
    eventId: 'event-1',
    workerId: 'worker-a',
    attemptedAt: '2026-09-06T02:00:00.000Z',
    error: 'provider unavailable',
    nextAttemptAt: '2026-09-06T02:00:01.000Z',
    maxAttempts: 3
  });
  assert.deepEqual(result, { claimed: 1, delivered: 0, retried: 1, deadLettered: 0 });
});

test('OutboxDispatcher treats a missing handler as a retryable delivery failure', async () => {
  let failure;
  const store = {
    async claimBatch() { return [event({ eventType: 'agency.case.opened' })]; },
    async markDelivered() { throw new Error('not expected'); },
    async markFailed(input) {
      failure = input;
      return event({ eventType: 'agency.case.opened', status: 'PENDING', attemptCount: 1 });
    }
  };
  const dispatcher = new OutboxDispatcher({
    outboxStore: store,
    handlers: {},
    workerId: 'worker-a',
    baseDelayMs: 1000,
    clock: fixedClock('2026-09-06T02:00:00.000Z')
  });

  const result = await dispatcher.runOnce();

  assert.match(failure.error, /No outbox handler registered for agency\.case\.opened/);
  assert.equal(result.retried, 1);
});

test('OutboxDispatcher reports dead-letter transition returned by the store', async () => {
  const store = {
    async claimBatch() { return [event({ attemptCount: 2 })]; },
    async markDelivered() { throw new Error('not expected'); },
    async markFailed(input) {
      return event({ status: 'DEAD_LETTER', attemptCount: 3, lastError: input.error });
    }
  };
  const dispatcher = new OutboxDispatcher({
    outboxStore: store,
    handlers: { 'filing.accepted': async () => { throw new Error('still unavailable'); } },
    workerId: 'worker-a',
    maxAttempts: 3,
    baseDelayMs: 1000,
    clock: fixedClock('2026-09-06T02:00:00.000Z')
  });

  const result = await dispatcher.runOnce();
  assert.deepEqual(result, { claimed: 1, delivered: 0, retried: 0, deadLettered: 1 });
});

test('OutboxDispatcher claims only its configured bounded batch size', async () => {
  let claimInput;
  const store = {
    async claimBatch(input) { claimInput = input; return []; },
    async markDelivered() {},
    async markFailed() {}
  };
  const dispatcher = new OutboxDispatcher({
    outboxStore: store,
    handlers: {},
    workerId: 'worker-a',
    batchSize: 37,
    leaseTimeoutMs: 120000,
    clock: fixedClock('2026-09-06T02:00:00.000Z')
  });

  const result = await dispatcher.runOnce();

  assert.equal(claimInput.limit, 37);
  assert.equal(claimInput.leaseTimeoutMs, 120000);
  assert.deepEqual(result, { claimed: 0, delivered: 0, retried: 0, deadLettered: 0 });
});
