'use strict';

const { randomUUID } = require('node:crypto');
const { authorize } = require('../../../packages/rbac');
const { ConflictError, NotFoundError, ValidationError } = require('./dciecms-service');
const {
  PaymentCallbackValidationError,
  normalizeProviderCode,
  normalizeVerifiedPaymentCallback
} = require('./payment-callback-verifier');

function applicationProviderCode(value) {
  if (value == null || String(value).trim() === '') return null;
  try {
    return normalizeProviderCode(value);
  } catch (error) {
    if (error instanceof PaymentCallbackValidationError) {
      throw new ValidationError('providerCode is invalid');
    }
    throw error;
  }
}

function applicationCallback(value) {
  try {
    return normalizeVerifiedPaymentCallback(value, {
      receivedAt: value?.receivedAt,
      bodySha256: value?.bodySha256
    });
  } catch (error) {
    if (error instanceof PaymentCallbackValidationError) {
      throw new ValidationError('Payment callback evidence is invalid');
    }
    throw error;
  }
}

function callbackMatchesEvent(callback, event) {
  return Boolean(event) &&
    event.providerCode === callback.providerCode &&
    event.providerEventId === callback.providerEventId &&
    event.paymentId === callback.paymentId &&
    event.bodySha256 === callback.bodySha256 &&
    event.providerReference === callback.providerReference &&
    event.eventStatus === callback.status &&
    Number(event.amountMinor) === callback.amountMinor &&
    event.currency === callback.currency &&
    event.occurredAt === callback.occurredAt;
}

function callbackMatchesPayment(callback, payment, { requirePending = false, requireConfirmed = false } = {}) {
  if (!payment) return false;
  if (!payment.providerCode || payment.providerCode !== callback.providerCode) return false;
  if (Number(payment.amountMinor) !== callback.amountMinor) return false;
  if (payment.currency !== callback.currency) return false;
  if (requirePending && payment.status !== 'PENDING') return false;
  if (requireConfirmed && payment.status !== 'CONFIRMED') return false;
  if (requireConfirmed && payment.providerReference !== callback.providerReference) return false;
  return true;
}

function stateConflict(error, message) {
  if (error?.code === 'PAYMENT_STATE_CONFLICT' || error?.code === 'PAYMENT_CALLBACK_STATE_CONFLICT') {
    throw new ConflictError(message);
  }
  throw error;
}

function installPaymentCallbackService(PersistentDciecmsService) {
  if (!PersistentDciecmsService || !PersistentDciecmsService.prototype) {
    throw new TypeError('PersistentDciecmsService constructor is required');
  }

  PersistentDciecmsService.prototype.createPayment = async function createPayment(actor, assessmentId, input = {}) {
    const assessment = await this.repository.getFeeAssessment(assessmentId);
    if (!assessment) throw new NotFoundError('Fee assessment not found');
    authorize(actor, 'finance.payment.create', { courtId: assessment.courtId });
    if (assessment.status !== 'ASSESSED') {
      throw new ConflictError(`Payment cannot be created for assessment status ${assessment.status}`);
    }

    const providerCode = applicationProviderCode(input?.providerCode);
    const payment = await this.repository.createPayment({
      paymentId: randomUUID(),
      assessmentId,
      courtId: assessment.courtId,
      amountMinor: assessment.amountMinor,
      currency: assessment.currency,
      providerCode,
      actorSubject: actor.userId,
      at: new Date().toISOString()
    });
    const auditDetails = {
      courtId: assessment.courtId,
      assessmentId,
      amountMinor: payment.amountMinor,
      currency: payment.currency
    };
    if (providerCode) auditDetails.providerCode = providerCode;
    await this._audit(actor, 'finance.payment.create', 'payment', payment.paymentId, auditDetails);
    return payment;
  };

  PersistentDciecmsService.prototype.confirmPaymentFromCallback = async function confirmPaymentFromCallback(value) {
    const callback = applicationCallback(value);
    const systemSubject = `payment-callback:${callback.providerCode}`;

    let claim;
    try {
      claim = await this.repository.claimPaymentCallback({
        callbackEventId: randomUUID(),
        providerCode: callback.providerCode,
        providerEventId: callback.providerEventId,
        paymentId: callback.paymentId,
        bodySha256: callback.bodySha256,
        providerReference: callback.providerReference,
        eventStatus: callback.status,
        amountMinor: callback.amountMinor,
        currency: callback.currency,
        occurredAt: callback.occurredAt,
        receivedAt: callback.receivedAt
      });
    } catch (error) {
      return stateConflict(error, 'Payment callback state conflict');
    }

    if (!claim.claimed) {
      if (!callbackMatchesEvent(callback, claim.event) || claim.event.processingStatus !== 'PROCESSED') {
        throw new ConflictError('Payment callback replay conflict');
      }
      const replayPayment = await this.repository.getPayment(callback.paymentId);
      if (!callbackMatchesPayment(callback, replayPayment, { requireConfirmed: true })) {
        throw new ConflictError('Payment callback canonical state conflict');
      }
      return replayPayment;
    }

    const payment = await this.repository.getPayment(callback.paymentId);
    if (!callbackMatchesPayment(callback, payment, { requirePending: true })) {
      throw new ConflictError('Payment callback does not match authoritative payment state');
    }

    const actor = Object.freeze({
      userId: systemSubject,
      roles: Object.freeze(['SYSTEM']),
      courtIds: Object.freeze([payment.courtId]),
      explicitGrants: Object.freeze([]),
      correlationId: null
    });

    let confirmed;
    try {
      confirmed = await this.repository.confirmPayment({
        paymentId: callback.paymentId,
        providerReference: callback.providerReference,
        actorSubject: systemSubject,
        at: callback.receivedAt
      });
    } catch (error) {
      return stateConflict(error, 'Payment callback payment-state conflict');
    }

    await this._audit(actor, 'finance.payment.confirm.callback', 'payment', callback.paymentId, {
      courtId: payment.courtId,
      providerCode: callback.providerCode,
      providerEventId: callback.providerEventId
    });

    await this._emitDomainEvent(actor, 'payment.confirmed', 'payment', callback.paymentId, {
      courtId: confirmed.courtId,
      payload: {
        paymentId: callback.paymentId,
        courtId: confirmed.courtId,
        status: confirmed.status,
        amountMinor: confirmed.amountMinor,
        currency: confirmed.currency
      }
    });

    try {
      await this.repository.markPaymentCallbackProcessed({
        callbackEventId: claim.event.callbackEventId,
        processedAt: callback.receivedAt
      });
    } catch (error) {
      return stateConflict(error, 'Payment callback completion conflict');
    }

    return confirmed;
  };
}

module.exports = {
  callbackMatchesEvent,
  callbackMatchesPayment,
  installPaymentCallbackService
};
