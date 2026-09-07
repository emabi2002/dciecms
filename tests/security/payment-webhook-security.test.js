'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PaymentWebhookService } = require('../../services/api/src/payment-webhook-service');

const VERIFIED_SUCCESS = Object.freeze({
  providerCode: 'approved-gateway',
  providerEventId: 'evt-1',
  providerPaymentReference: 'gw-pay-1',
  paymentId: '11111111-1111-1111-1111-111111111111',
  eventType: 'PAYMENT_SUCCEEDED',
  amountMinor: 12500,
  currency: 'PGK',
  authenticatedAt: '2026-09-07T01:00:00.000Z'
});

function fixture({ verify = null, maxBodyBytes = 1024 } = {}) {
  const verifyCalls = [];
  const provider = {
    capabilities() { return { providerCode: 'approved-gateway', webhookVerification: true, developmentOnly: false }; },
    async createPaymentSession() { throw new Error('not used'); },
    async verifyWebhook(input) {
      verifyCalls.push(input);
      if (verify) return verify(input);
      return { ...VERIFIED_SUCCESS };
    }
  };
  const records = new Map();
  const repositoryCalls = [];
  let confirmCalls = 0;
  const repository = {
    async recordPaymentProviderEvent(input) {
      repositoryCalls.push({ ...input });
      const key = `${input.providerCode}:${input.providerEventId}`;
      if (!records.has(key)) records.set(key, Object.freeze({ eventRecordId: `record:${key}`, ...input }));
      return records.get(key);
    },
    async confirmPaymentFromProviderEvidence() {
      confirmCalls += 1;
      throw new Error('webhook ingestion must not confirm payments directly');
    }
  };
  const service = new PaymentWebhookService({
    repository,
    provider,
    providerCode: 'approved-gateway',
    maxBodyBytes,
    clock: () => new Date('2026-09-07T01:00:01.000Z')
  });
  return { service, verifyCalls, repositoryCalls, records, getConfirmCalls: () => confirmCalls };
}

test('webhook verification receives original raw bytes before any JSON trust', async () => {
  const rawBody = Buffer.from('{definitely-not-json-but-provider-authenticates-it');
  const { service, verifyCalls, repositoryCalls } = fixture();
  const result = await service.ingest({ rawBody, headers: { 'x-provider-signature': 'secret-proof' } });

  assert.equal(verifyCalls.length, 1);
  assert.equal(Buffer.isBuffer(verifyCalls[0].rawBody), true);
  assert.equal(verifyCalls[0].rawBody.equals(rawBody), true);
  assert.equal(repositoryCalls.length, 1);
  assert.equal(result.providerEventId, 'evt-1');
});

test('invalid or stale provider proof fails before durable inbox or business mutation', async () => {
  for (const message of ['invalid signature', 'stale verified-provider timestamp']) {
    const { service, repositoryCalls, getConfirmCalls } = fixture({
      verify: async () => { throw new Error(message); }
    });
    await assert.rejects(
      () => service.ingest({ rawBody: Buffer.from('raw-provider-body'), headers: { authorization: 'provider-secret' } }),
      /webhook|provider|verification|invalid|stale/i
    );
    assert.equal(repositoryCalls.length, 0);
    assert.equal(getConfirmCalls(), 0);
  }
});

test('webhook body is bounded before provider verification', async () => {
  const { service, verifyCalls, repositoryCalls } = fixture({ maxBodyBytes: 16 });
  await assert.rejects(
    () => service.ingest({ rawBody: Buffer.alloc(17, 65), headers: {} }),
    /body|size|large|limit/i
  );
  assert.equal(verifyCalls.length, 0);
  assert.equal(repositoryCalls.length, 0);
});

test('only normalized verified event evidence enters the durable inbox', async () => {
  const rawSecret = 'raw-signature-token-DO-NOT-PERSIST';
  const { service, repositoryCalls, getConfirmCalls } = fixture();
  await service.ingest({
    rawBody: Buffer.from(`opaque:${rawSecret}`),
    headers: { 'x-provider-signature': rawSecret, authorization: `Bearer ${rawSecret}` }
  });

  assert.equal(repositoryCalls.length, 1);
  const persisted = JSON.stringify(repositoryCalls[0]);
  assert.equal(persisted.includes(rawSecret), false);
  assert.deepEqual(repositoryCalls[0], {
    providerCode: 'approved-gateway',
    providerEventId: 'evt-1',
    providerPaymentReference: 'gw-pay-1',
    paymentId: '11111111-1111-1111-1111-111111111111',
    normalizedEventType: 'PAYMENT_SUCCEEDED',
    amountMinor: 12500,
    currency: 'PGK',
    authenticatedAt: '2026-09-07T01:00:00.000Z',
    receivedAt: '2026-09-07T01:00:01.000Z'
  });
  assert.equal(getConfirmCalls(), 0);
});

test('malformed cross-provider or unknown normalized events fail closed before persistence', async () => {
  const invalidEvents = [
    { ...VERIFIED_SUCCESS, providerCode: 'other-gateway' },
    { ...VERIFIED_SUCCESS, providerEventId: '' },
    { ...VERIFIED_SUCCESS, providerPaymentReference: '' },
    { ...VERIFIED_SUCCESS, paymentId: '' },
    { ...VERIFIED_SUCCESS, eventType: 'PAYMENT_MAYBE' },
    { ...VERIFIED_SUCCESS, amountMinor: 0 },
    { ...VERIFIED_SUCCESS, currency: 'US' }
  ];

  for (const event of invalidEvents) {
    const { service, repositoryCalls, getConfirmCalls } = fixture({ verify: async () => ({ ...event }) });
    await assert.rejects(
      () => service.ingest({ rawBody: Buffer.from('authenticated-provider-body'), headers: {} }),
      /provider|event|reference|payment|amount|currency|normalized/i
    );
    assert.equal(repositoryCalls.length, 0);
    assert.equal(getConfirmCalls(), 0);
  }
});

test('duplicate verified provider event reuses the durable canonical inbox record', async () => {
  const { service, records, repositoryCalls, getConfirmCalls } = fixture();
  const first = await service.ingest({ rawBody: Buffer.from('provider-event-one'), headers: {} });
  const second = await service.ingest({ rawBody: Buffer.from('provider-event-one-retry'), headers: {} });

  assert.equal(repositoryCalls.length, 2);
  assert.equal(records.size, 1);
  assert.equal(second.eventRecordId, first.eventRecordId);
  assert.equal(getConfirmCalls(), 0);
});

test('failure and cancellation events may omit settlement amount but still require correlation and reference', async () => {
  for (const eventType of ['PAYMENT_FAILED', 'PAYMENT_CANCELLED']) {
    const event = { ...VERIFIED_SUCCESS, eventType, amountMinor: null, currency: null };
    const { service, repositoryCalls } = fixture({ verify: async () => event });
    await service.ingest({ rawBody: Buffer.from('verified-non-success-event'), headers: {} });
    assert.equal(repositoryCalls[0].normalizedEventType, eventType);
    assert.equal(repositoryCalls[0].amountMinor, null);
    assert.equal(repositoryCalls[0].currency, null);
  }
});
