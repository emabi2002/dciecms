'use strict';

const SYSTEM_ACTOR = 'system:payment-provider';
const TERMINAL_EVENT_STATES = new Set(['PROCESSED', 'REJECTED', 'DEAD_LETTER']);
const KNOWN_EVENT_TYPES = new Set([
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'PAYMENT_CANCELLED',
  'PAYMENT_REFUNDED',
  'PAYMENT_REVERSED'
]);

function requireMethod(target, methodName, label) {
  if (!target || typeof target[methodName] !== 'function') {
    throw new TypeError(`${label} must expose ${methodName}()`);
  }
}

function normalizeClock(clock) {
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.now === 'function') return () => clock.now();
  return () => new Date();
}

function normalizedText(value) {
  return String(value || '').trim();
}

function normalizedCode(value) {
  return normalizedText(value).toUpperCase();
}

function normalizedProvider(value) {
  return normalizedText(value).toLowerCase();
}

function normalizedCurrency(value) {
  return normalizedText(value).toUpperCase();
}

function samePaymentIdentity(payment, event) {
  return Boolean(payment) &&
    normalizedText(payment.paymentId) === normalizedText(event.paymentId) &&
    normalizedProvider(payment.providerCode) === normalizedProvider(event.providerCode) &&
    normalizedText(payment.providerPaymentReference) === normalizedText(event.providerPaymentReference);
}

function sameSettlementEvidence(payment, event) {
  return samePaymentIdentity(payment, event) &&
    Number(payment.amountMinor) === Number(event.amountMinor) &&
    normalizedCurrency(payment.currency) === normalizedCurrency(event.currency);
}

function optionalEvidenceMatches(payment, event) {
  const hasAmount = event.amountMinor !== null && event.amountMinor !== undefined;
  const hasCurrency = event.currency !== null && event.currency !== undefined && normalizedText(event.currency) !== '';
  if (!hasAmount && !hasCurrency) return true;
  if (hasAmount !== hasCurrency) return false;
  return Number(payment.amountMinor) === Number(event.amountMinor) &&
    normalizedCurrency(payment.currency) === normalizedCurrency(event.currency);
}

class PaymentEventProcessor {
  constructor({ repository, auditStore, outboxStore, transactionManager, clock = () => new Date() } = {}) {
    requireMethod(repository, 'getPaymentProviderBinding', 'repository');
    requireMethod(repository, 'confirmPaymentFromProviderEvidence', 'repository');
    requireMethod(repository, 'transitionPaymentProviderOutcome', 'repository');
    requireMethod(repository, 'markPaymentProviderEventProcessed', 'repository');
    requireMethod(repository, 'markPaymentProviderEventRejected', 'repository');
    requireMethod(auditStore, 'append', 'auditStore');
    requireMethod(outboxStore, 'enqueue', 'outboxStore');
    requireMethod(transactionManager, 'withTransaction', 'transactionManager');
    this.repository = repository;
    this.auditStore = auditStore;
    this.outboxStore = outboxStore;
    this.transactionManager = transactionManager;
    this.clock = normalizeClock(clock);
  }

  _nowIso() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('clock returned an invalid timestamp');
    return date.toISOString();
  }

  _validateEventEnvelope(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('Canonical payment provider event is required');
    }
    if (!normalizedText(event.eventRecordId)) {
      throw new TypeError('Canonical payment provider event record id is required');
    }
    return event;
  }

  async _reject(event, resultCode, payment = null, processedAt = this._nowIso()) {
    const rejected = await this.repository.markPaymentProviderEventRejected({
      eventRecordId: event.eventRecordId,
      resultCode,
      processedAt
    });
    return Object.freeze({ payment, event: rejected, duplicate: false });
  }

  async _audit(payment, action, details = {}) {
    return this.auditStore.append({
      actorUserId: SYSTEM_ACTOR,
      effectiveRoles: [],
      action,
      resourceType: 'payment',
      resourceId: payment.paymentId,
      courtId: payment.courtId,
      correlationId: null,
      details: Object.freeze({ source: 'verified_provider_event', ...details })
    });
  }

  async _emitConfirmed(payment) {
    return this.outboxStore.enqueue({
      eventType: 'payment.confirmed',
      aggregateType: 'payment',
      aggregateId: payment.paymentId,
      courtId: payment.courtId,
      actorSubject: SYSTEM_ACTOR,
      correlationId: null,
      deduplicationKey: `${payment.paymentId}:payment.confirmed`,
      payload: Object.freeze({
        paymentId: payment.paymentId,
        courtId: payment.courtId,
        status: payment.status,
        amountMinor: payment.amountMinor,
        currency: payment.currency
      }),
      headers: Object.freeze({ schemaVersion: 1 })
    });
  }

  async _processSuccess(event, payment, now) {
    if (!sameSettlementEvidence(payment, event) || payment.status !== 'PENDING') {
      return this._reject(event, 'PAYMENT_EVIDENCE_MISMATCH', payment, now);
    }

    let confirmed;
    try {
      confirmed = await this.repository.confirmPaymentFromProviderEvidence({
        paymentId: payment.paymentId,
        providerCode: normalizedProvider(event.providerCode),
        providerPaymentReference: normalizedText(event.providerPaymentReference),
        amountMinor: Number(event.amountMinor),
        currency: normalizedCurrency(event.currency),
        confirmedAt: now,
        actorSubject: SYSTEM_ACTOR
      });
    } catch (error) {
      if (error?.code === 'PAYMENT_PROVIDER_EVIDENCE_CONFLICT') {
        return this._reject(event, 'PAYMENT_EVIDENCE_MISMATCH', payment, now);
      }
      throw error;
    }

    await this._audit(confirmed, 'finance.payment.confirm');
    await this._emitConfirmed(confirmed);
    const processed = await this.repository.markPaymentProviderEventProcessed({
      eventRecordId: event.eventRecordId,
      resultCode: 'PAYMENT_CONFIRMED',
      processedAt: now
    });
    return Object.freeze({ payment: confirmed, event: processed, duplicate: false });
  }

  async _processPendingOutcome(event, payment, now, action, resultCode) {
    if (!samePaymentIdentity(payment, event) || !optionalEvidenceMatches(payment, event) || payment.status !== 'PENDING') {
      return this._reject(event, 'PAYMENT_EVIDENCE_MISMATCH', payment, now);
    }

    let updated;
    try {
      updated = await this.repository.transitionPaymentProviderOutcome({
        paymentId: payment.paymentId,
        providerCode: normalizedProvider(event.providerCode),
        providerPaymentReference: normalizedText(event.providerPaymentReference),
        normalizedEventType: normalizedCode(event.normalizedEventType),
        at: now,
        resultCode
      });
    } catch (error) {
      if (error?.code === 'PAYMENT_PROVIDER_OUTCOME_CONFLICT') {
        return this._reject(event, 'PAYMENT_EVIDENCE_MISMATCH', payment, now);
      }
      throw error;
    }

    await this._audit(updated, action, { outcome: resultCode });
    const processed = await this.repository.markPaymentProviderEventProcessed({
      eventRecordId: event.eventRecordId,
      resultCode,
      processedAt: now
    });
    return Object.freeze({ payment: updated, event: processed, duplicate: false });
  }

  async _processPostConfirmationOutcome(event, payment, now, action, resultCode) {
    if (!sameSettlementEvidence(payment, event) || payment.status !== 'CONFIRMED') {
      return this._reject(event, 'PAYMENT_EVIDENCE_MISMATCH', payment, now);
    }

    let updated;
    try {
      updated = await this.repository.transitionPaymentProviderOutcome({
        paymentId: payment.paymentId,
        providerCode: normalizedProvider(event.providerCode),
        providerPaymentReference: normalizedText(event.providerPaymentReference),
        normalizedEventType: normalizedCode(event.normalizedEventType),
        at: now,
        resultCode
      });
    } catch (error) {
      if (error?.code === 'PAYMENT_PROVIDER_OUTCOME_CONFLICT') {
        return this._reject(event, 'PAYMENT_EVIDENCE_MISMATCH', payment, now);
      }
      throw error;
    }

    await this._audit(updated, action, { outcome: resultCode });
    const processed = await this.repository.markPaymentProviderEventProcessed({
      eventRecordId: event.eventRecordId,
      resultCode,
      processedAt: now
    });
    return Object.freeze({ payment: updated, event: processed, duplicate: false });
  }

  async process(input) {
    const event = this._validateEventEnvelope(input);
    const existingState = normalizedCode(event.processingStatus);
    if (TERMINAL_EVENT_STATES.has(existingState)) {
      return Object.freeze({ payment: null, event, duplicate: true });
    }

    return this.transactionManager.withTransaction(async () => {
      const now = this._nowIso();
      const type = normalizedCode(event.normalizedEventType);
      if (!KNOWN_EVENT_TYPES.has(type)) {
        return this._reject(event, 'UNKNOWN_PROVIDER_EVENT', null, now);
      }

      const payment = await this.repository.getPaymentProviderBinding(event.paymentId);
      if (!payment || !samePaymentIdentity(payment, event)) {
        return this._reject(event, 'PAYMENT_EVIDENCE_MISMATCH', payment, now);
      }

      if (type === 'PAYMENT_SUCCEEDED') {
        return this._processSuccess(event, payment, now);
      }
      if (type === 'PAYMENT_FAILED') {
        return this._processPendingOutcome(event, payment, now, 'finance.payment.fail', 'PAYMENT_FAILED');
      }
      if (type === 'PAYMENT_CANCELLED') {
        return this._processPendingOutcome(event, payment, now, 'finance.payment.cancel', 'PAYMENT_CANCELLED');
      }
      if (type === 'PAYMENT_REFUNDED') {
        return this._processPostConfirmationOutcome(event, payment, now, 'finance.payment.refund', 'PAYMENT_REFUNDED');
      }
      return this._processPostConfirmationOutcome(event, payment, now, 'finance.payment.reverse', 'PAYMENT_REVERSED');
    });
  }
}

module.exports = { PaymentEventProcessor, SYSTEM_ACTOR };
