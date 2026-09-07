'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveActorFromClaims } = require('../../packages/auth');
const { PaymentIntegrationService } = require('../../services/api/src/payment-integration-service');

const PAYMENT = Object.freeze({
  paymentId: '11111111-1111-1111-1111-111111111111',
  assessmentId: '22222222-2222-2222-2222-222222222222',
  courtId: 'COURT-A',
  amountMinor: 12500,
  currency: 'PGK',
  status: 'PENDING',
  providerCode: null,
  providerPaymentReference: null
});

function actor({ sub = 'fin-a', roles = ['FIN'], courts = ['COURT-A'] } = {}) {
  return resolveActorFromClaims({ sub, roles, court_ids: courts });
}

function fixture({ payment = PAYMENT, session = null } = {}) {
  const repo = {
    payment: payment ? { ...payment } : null,
    bindCalls: [],
    async getPaymentProviderBinding() { return this.payment ? Object.freeze({ ...this.payment }) : null; },
    async bindPaymentProviderSession(input) {
      this.bindCalls.push({ ...input });
      this.payment = {
        ...this.payment,
        providerCode: input.providerCode,
        providerPaymentReference: input.providerPaymentReference,
        providerStatus: input.providerStatus,
        sessionCreatedAt: input.sessionCreatedAt
      };
      return Object.freeze({ ...this.payment });
    }
  };
  const providerCalls = [];
  const provider = {
    capabilities() { return { providerCode: 'approved-gateway', webhookVerification: true, developmentOnly: false }; },
    async createPaymentSession(input) {
      providerCalls.push({ ...input });
      return session || {
        providerCode: 'approved-gateway',
        providerPaymentReference: 'gw-pay-1',
        checkoutUrl: 'https://checkout.example.invalid/session/abc',
        expiresAt: '2026-09-07T00:15:00.000Z'
      };
    },
    async verifyWebhook() {}
  };
  const auditEvents = [];
  const auditStore = { async append(event) { auditEvents.push({ ...event }); return event; } };
  const service = new PaymentIntegrationService({
    repository: repo,
    provider,
    providerCode: 'approved-gateway',
    auditStore,
    clock: () => new Date('2026-09-07T00:00:00.000Z')
  });
  return { service, repo, providerCalls, auditEvents };
}

test('payment session creation uses canonical server payment identity amount and currency', async () => {
  const { service, providerCalls, repo } = fixture();
  const result = await service.createPaymentSession(actor(), PAYMENT.paymentId, {});

  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].paymentId, PAYMENT.paymentId);
  assert.equal(providerCalls[0].amountMinor, 12500);
  assert.equal(providerCalls[0].currency, 'PGK');
  assert.equal(providerCalls[0].idempotencyKey, `payment-session:${PAYMENT.paymentId}`);
  assert.equal(repo.bindCalls.length, 1);
  assert.equal(repo.bindCalls[0].providerCode, 'approved-gateway');
  assert.equal(repo.bindCalls[0].providerPaymentReference, 'gw-pay-1');
  assert.equal(result.payment.providerPaymentReference, 'gw-pay-1');
  assert.equal(result.checkoutUrl, 'https://checkout.example.invalid/session/abc');
});

test('caller cannot override canonical amount currency provider or provider reference', async () => {
  const { service, providerCalls } = fixture();
  for (const input of [
    { amountMinor: 1 },
    { currency: 'USD' },
    { providerCode: 'other' },
    { providerPaymentReference: 'forged' },
    { providerReference: 'legacy-forged' }
  ]) {
    await assert.rejects(() => service.createPaymentSession(actor(), PAYMENT.paymentId, input), /caller-controlled|not accepted|override/i);
  }
  assert.equal(providerCalls.length, 0);
});

test('payment session requires payment existence base permission and court scope', async () => {
  await assert.rejects(() => fixture({ payment: null }).service.createPaymentSession(actor(), PAYMENT.paymentId, {}), /not found/i);
  await assert.rejects(
    () => fixture().service.createPaymentSession(actor({ roles: ['REG'], courts: ['COURT-A'] }), PAYMENT.paymentId, {}),
    /permission denied/i
  );
  await assert.rejects(
    () => fixture().service.createPaymentSession(actor({ courts: ['COURT-B'] }), PAYMENT.paymentId, {}),
    /court scope/i
  );
});

test('only an eligible pending payment may create an external session', async () => {
  const { service, providerCalls } = fixture({ payment: { ...PAYMENT, status: 'CONFIRMED' } });
  await assert.rejects(() => service.createPaymentSession(actor(), PAYMENT.paymentId, {}), /pending|eligible/i);
  assert.equal(providerCalls.length, 0);
});

test('malformed or cross-provider session response fails closed without binding', async () => {
  for (const session of [
    {},
    { providerCode: 'other-gateway', providerPaymentReference: 'x', checkoutUrl: 'https://checkout.example.invalid/x' },
    { providerCode: 'approved-gateway', checkoutUrl: 'https://checkout.example.invalid/x' },
    { providerCode: 'approved-gateway', providerPaymentReference: 'x' }
  ]) {
    const { service, repo } = fixture({ session });
    await assert.rejects(() => service.createPaymentSession(actor(), PAYMENT.paymentId, {}), /provider session|provider code|reference|checkout/i);
    assert.equal(repo.bindCalls.length, 0);
  }
});

test('checkout material is ephemeral and never written to audit or provider binding input', async () => {
  const { service, repo, auditEvents } = fixture();
  const result = await service.createPaymentSession(actor(), PAYMENT.paymentId, {});
  assert.equal(result.checkoutUrl.includes('/session/abc'), true);
  assert.equal(JSON.stringify(repo.bindCalls).includes(result.checkoutUrl), false);
  assert.equal(JSON.stringify(auditEvents).includes(result.checkoutUrl), false);
  assert.equal(auditEvents.at(-1).action, 'finance.payment.session.create');
});

test('repeated session request uses the same stable provider idempotency key and canonical binding', async () => {
  const { service, repo, providerCalls } = fixture();
  const first = await service.createPaymentSession(actor(), PAYMENT.paymentId, {});
  const second = await service.createPaymentSession(actor(), PAYMENT.paymentId, {});

  assert.equal(providerCalls.length, 2);
  assert.equal(providerCalls[0].idempotencyKey, providerCalls[1].idempotencyKey);
  assert.equal(providerCalls[0].idempotencyKey, `payment-session:${PAYMENT.paymentId}`);
  assert.equal(repo.bindCalls.length, 1);
  assert.equal(second.payment.providerPaymentReference, first.payment.providerPaymentReference);
});
