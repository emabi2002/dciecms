'use strict';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function frozen(value) {
  return Object.freeze(clone(value));
}

function normalizedProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedCurrency(value) {
  return String(value || '').trim().toUpperCase();
}

function providerConflict(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class MemoryPaymentIntegrationRepository {
  constructor() {
    this.payments = new Map();
    this.events = new Map();
  }

  seedPayment(payment) {
    if (!payment?.paymentId) throw new TypeError('payment.paymentId is required');
    const canonical = {
      providerCode: null,
      providerPaymentReference: null,
      providerStatus: null,
      sessionCreatedAt: null,
      providerConfirmedAt: null,
      failureCode: null,
      cancelledAt: null,
      refundedAt: null,
      reversedAt: null,
      confirmedBy: null,
      confirmedAt: null,
      ...clone(payment)
    };
    this.payments.set(canonical.paymentId, canonical);
    return frozen(canonical);
  }

  async getPaymentProviderBinding(paymentId) {
    return frozen(this.payments.get(paymentId) || null);
  }

  async bindPaymentProviderSession({
    paymentId,
    providerCode,
    providerPaymentReference,
    providerStatus = 'SESSION_CREATED',
    sessionCreatedAt
  }) {
    const payment = this.payments.get(paymentId);
    if (!payment || payment.status !== 'PENDING' || payment.providerCode || payment.providerPaymentReference) {
      throw providerConflict('PAYMENT_PROVIDER_BINDING_CONFLICT', 'Payment is not eligible for provider binding');
    }
    Object.assign(payment, {
      providerCode: normalizedProvider(providerCode),
      providerPaymentReference: String(providerPaymentReference || '').trim(),
      providerStatus,
      sessionCreatedAt
    });
    return frozen(payment);
  }

  async recordPaymentProviderEvent({
    providerCode,
    providerEventId,
    providerPaymentReference,
    paymentId,
    normalizedEventType,
    amountMinor = null,
    currency = null,
    authenticatedAt,
    receivedAt = authenticatedAt,
    maxAttempts = 5
  }) {
    const canonicalProvider = normalizedProvider(providerCode);
    const key = `${canonicalProvider}:${String(providerEventId || '').trim()}`;
    const existing = this.events.get(key);
    if (existing) return frozen(existing);

    const row = {
      eventRecordId: `payment-provider-event:${key}`,
      providerCode: canonicalProvider,
      providerEventId: String(providerEventId || '').trim(),
      providerPaymentReference: String(providerPaymentReference || '').trim(),
      paymentId: String(paymentId || '').trim() || null,
      normalizedEventType: String(normalizedEventType || '').trim().toUpperCase(),
      amountMinor: amountMinor == null ? null : Number(amountMinor),
      currency: currency == null ? null : normalizedCurrency(currency),
      processingStatus: 'RECEIVED',
      attemptCount: 0,
      maxAttempts,
      nextAttemptAt: receivedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      resultCode: null,
      receivedAt,
      authenticatedAt,
      processedAt: null,
      createdAt: receivedAt,
      updatedAt: receivedAt
    };
    this.events.set(key, row);
    return frozen(row);
  }

  _findEvent(eventRecordId) {
    for (const event of this.events.values()) {
      if (event.eventRecordId === eventRecordId) return event;
    }
    return null;
  }

  async getPaymentProviderEvent(eventRecordId) {
    return frozen(this._findEvent(eventRecordId) || null);
  }

  async confirmPaymentFromProviderEvidence({
    paymentId,
    providerCode,
    providerPaymentReference,
    amountMinor,
    currency,
    confirmedAt,
    actorSubject = 'system:payment-provider'
  }) {
    const payment = this.payments.get(paymentId);
    const matches = payment &&
      payment.status === 'PENDING' &&
      normalizedProvider(payment.providerCode) === normalizedProvider(providerCode) &&
      String(payment.providerPaymentReference || '') === String(providerPaymentReference || '') &&
      Number(payment.amountMinor) === Number(amountMinor) &&
      normalizedCurrency(payment.currency) === normalizedCurrency(currency);
    if (!matches) {
      throw providerConflict('PAYMENT_PROVIDER_EVIDENCE_CONFLICT', 'Provider payment evidence does not match the canonical payment');
    }
    Object.assign(payment, {
      status: 'CONFIRMED',
      providerStatus: 'SUCCEEDED',
      providerConfirmedAt: confirmedAt,
      confirmedBy: actorSubject,
      confirmedAt
    });
    return frozen(payment);
  }

  async transitionPaymentProviderOutcome({
    paymentId,
    providerCode,
    providerPaymentReference,
    normalizedEventType,
    at,
    resultCode
  }) {
    const payment = this.payments.get(paymentId);
    const type = String(normalizedEventType || '').trim().toUpperCase();
    const sameBinding = payment &&
      normalizedProvider(payment.providerCode) === normalizedProvider(providerCode) &&
      String(payment.providerPaymentReference || '') === String(providerPaymentReference || '');
    if (!sameBinding) {
      throw providerConflict('PAYMENT_PROVIDER_OUTCOME_CONFLICT', 'Provider outcome does not match the canonical payment');
    }

    if (type === 'PAYMENT_FAILED' && payment.status === 'PENDING') {
      Object.assign(payment, { status: 'FAILED', providerStatus: 'FAILED', failureCode: resultCode || 'PAYMENT_FAILED' });
      return frozen(payment);
    }
    if (type === 'PAYMENT_CANCELLED' && payment.status === 'PENDING') {
      Object.assign(payment, { status: 'CANCELLED', providerStatus: 'CANCELLED', cancelledAt: at });
      return frozen(payment);
    }
    if (type === 'PAYMENT_REFUNDED' && payment.status === 'CONFIRMED') {
      Object.assign(payment, { status: 'REFUNDED', providerStatus: 'REFUNDED', refundedAt: at });
      return frozen(payment);
    }
    if (type === 'PAYMENT_REVERSED' && payment.status === 'CONFIRMED') {
      Object.assign(payment, { status: 'REFUNDED', providerStatus: 'REVERSED', reversedAt: at });
      return frozen(payment);
    }
    throw providerConflict('PAYMENT_PROVIDER_OUTCOME_CONFLICT', 'Payment is not eligible for the provider outcome');
  }

  async markPaymentProviderEventProcessed({ eventRecordId, resultCode, processedAt }) {
    const event = this._findEvent(eventRecordId);
    if (!event || event.processingStatus !== 'RECEIVED') {
      throw providerConflict('PAYMENT_PROVIDER_EVENT_STATE_CONFLICT', 'Canonical provider event is not eligible for processing');
    }
    Object.assign(event, {
      processingStatus: 'PROCESSED',
      resultCode: String(resultCode || '').trim(),
      processedAt,
      updatedAt: processedAt
    });
    return frozen(event);
  }

  async markPaymentProviderEventRejected({ eventRecordId, resultCode, processedAt }) {
    const event = this._findEvent(eventRecordId);
    if (!event || event.processingStatus !== 'RECEIVED') {
      throw providerConflict('PAYMENT_PROVIDER_EVENT_STATE_CONFLICT', 'Canonical provider event is not eligible for rejection');
    }
    Object.assign(event, {
      processingStatus: 'REJECTED',
      resultCode: String(resultCode || '').trim(),
      processedAt,
      updatedAt: processedAt
    });
    return frozen(event);
  }
}

class MemoryPaymentOutboxStore {
  constructor() {
    this.events = [];
  }

  async enqueue(event) {
    const key = `${event.eventType}:${event.deduplicationKey}`;
    const existing = this.events.find(item => `${item.eventType}:${item.deduplicationKey}` === key);
    if (existing) return frozen(existing);
    const canonical = clone(event);
    this.events.push(canonical);
    return frozen(canonical);
  }
}

class MemoryTransactionManager {
  async withTransaction(work) {
    return work();
  }
}

module.exports = {
  MemoryPaymentIntegrationRepository,
  MemoryPaymentOutboxStore,
  MemoryTransactionManager
};
