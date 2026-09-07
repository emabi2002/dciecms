'use strict';

const {
  normalizeVerifiedPaymentCallback
} = require('./payment-gateway-verifier');

const PAYMENT_GATEWAY_SYSTEM_ACTOR = Object.freeze({
  userId:'system:payment-gateway',
  subject:'system:payment-gateway',
  roles:Object.freeze(['SYSTEM']),
  courtIds:Object.freeze([]),
  explicitGrants:Object.freeze([])
});

const REJECTABLE_PAYMENT_EVIDENCE_CODES = new Set([
  'PAYMENT_GATEWAY_AMOUNT_MISMATCH',
  'PAYMENT_GATEWAY_CURRENCY_MISMATCH',
  'PAYMENT_GATEWAY_REFERENCE_MISMATCH'
]);

function requireMethod(target, method, label) {
  if (!target || typeof target[method] !== 'function') {
    throw new TypeError(`${label} must expose ${method}()`);
  }
}

function isoTime(value, name) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function stateConflict(message) {
  const error = new Error(message);
  error.code = 'PAYMENT_CALLBACK_STATE_CONFLICT';
  return error;
}

function frozenResult(value) {
  return Object.freeze(value);
}

function replayResult(callback) {
  const status = String(callback?.processingStatus || '').trim().toUpperCase();
  if (!['APPLIED','IGNORED','REJECTED'].includes(status)) {
    throw stateConflict('Payment callback replay is not in a terminal state');
  }
  return frozenResult({
    status,
    replay:true,
    callbackId:callback.callbackId,
    paymentId:callback.paymentId || null,
    outcomeCode:callback.outcomeCode || null,
    failureCode:callback.failureCode || null
  });
}

class PaymentGatewayService {
  constructor({ repository, callbackStore, auditStore, outboxStore, transactionManager } = {}) {
    requireMethod(repository, 'confirmPaymentFromVerifiedGateway', 'repository');
    requireMethod(callbackStore, 'claim', 'callbackStore');
    requireMethod(callbackStore, 'markApplied', 'callbackStore');
    requireMethod(callbackStore, 'markIgnored', 'callbackStore');
    requireMethod(callbackStore, 'markRejected', 'callbackStore');
    requireMethod(auditStore, 'append', 'auditStore');
    requireMethod(outboxStore, 'enqueue', 'outboxStore');
    requireMethod(transactionManager, 'withTransaction', 'transactionManager');

    this.repository = repository;
    this.callbackStore = callbackStore;
    this.auditStore = auditStore;
    this.outboxStore = outboxStore;
    this.transactionManager = transactionManager;
  }

  async _audit(action, paymentReference, details = {}) {
    return this.auditStore.append({
      actorUserId:PAYMENT_GATEWAY_SYSTEM_ACTOR.userId,
      effectiveRoles:PAYMENT_GATEWAY_SYSTEM_ACTOR.roles,
      action,
      resourceType:'payment',
      resourceId:paymentReference,
      courtId:details.courtId || null,
      details:{
        provider:details.provider,
        providerEventId:details.providerEventId,
        callbackId:details.callbackId,
        outcomeCode:details.outcomeCode || null,
        failureCode:details.failureCode || null
      }
    });
  }

  async processVerifiedCallback({
    verifiedCallback,
    payloadDigestSha256,
    receivedAt = new Date().toISOString()
  } = {}) {
    const callback = normalizeVerifiedPaymentCallback(verifiedCallback);
    const received = isoTime(receivedAt, 'receivedAt');

    return this.transactionManager.withTransaction(async () => {
      const claim = await this.callbackStore.claim(callback, {
        payloadDigestSha256,
        receivedAt:received
      });

      if (claim.kind === 'REPLAY') return replayResult(claim.callback);
      if (claim.kind !== 'NEW' || !claim.callback?.callbackId) {
        throw stateConflict('Payment callback claim did not return a new canonical record');
      }

      const callbackId = claim.callback.callbackId;

      if (callback.eventType === 'PAYMENT_FAILED') {
        const outcomeCode = 'GATEWAY_PAYMENT_FAILED';
        await this.callbackStore.markIgnored({
          callbackId,
          outcomeCode,
          processedAt:received
        });
        await this._audit('payment.gateway.failed', callback.paymentReference, {
          provider:callback.provider,
          providerEventId:callback.eventId,
          callbackId,
          outcomeCode
        });
        return frozenResult({
          status:'IGNORED', replay:false, callbackId,
          paymentId:null, outcomeCode, failureCode:null
        });
      }

      let confirmed;
      try {
        confirmed = await this.repository.confirmPaymentFromVerifiedGateway({
          paymentReference:callback.paymentReference,
          providerPaymentReference:callback.providerPaymentReference,
          amountMinor:callback.amountMinor,
          currency:callback.currency,
          actorSubject:PAYMENT_GATEWAY_SYSTEM_ACTOR.userId,
          confirmedAt:callback.occurredAt
        });
      } catch (error) {
        if (!REJECTABLE_PAYMENT_EVIDENCE_CODES.has(error?.code)) throw error;

        await this.callbackStore.markRejected({
          callbackId,
          failureCode:error.code,
          processedAt:received
        });
        await this._audit('payment.gateway.rejected', callback.paymentReference, {
          provider:callback.provider,
          providerEventId:callback.eventId,
          callbackId,
          failureCode:error.code
        });
        return frozenResult({
          status:'REJECTED', replay:false, callbackId,
          paymentId:null, outcomeCode:null, failureCode:error.code
        });
      }

      const outcomeCode = 'PAYMENT_CONFIRMED';
      await this.callbackStore.markApplied({
        callbackId,
        paymentId:confirmed.paymentId,
        outcomeCode,
        processedAt:received
      });

      await this._audit('payment.gateway.confirmed', confirmed.paymentId, {
        courtId:confirmed.courtId,
        provider:callback.provider,
        providerEventId:callback.eventId,
        callbackId,
        outcomeCode
      });

      await this.outboxStore.enqueue({
        eventType:'payment.confirmed',
        aggregateType:'payment',
        aggregateId:confirmed.paymentId,
        courtId:confirmed.courtId,
        actorSubject:PAYMENT_GATEWAY_SYSTEM_ACTOR.userId,
        correlationId:null,
        deduplicationKey:`${confirmed.paymentId}:payment.confirmed`,
        payload:{
          paymentId:confirmed.paymentId,
          courtId:confirmed.courtId,
          status:confirmed.status,
          amountMinor:confirmed.amountMinor,
          currency:confirmed.currency
        },
        headers:{ schemaVersion:1 }
      });

      return frozenResult({
        status:'APPLIED', replay:false, callbackId,
        paymentId:confirmed.paymentId, outcomeCode, failureCode:null
      });
    });
  }
}

module.exports = {
  PAYMENT_GATEWAY_SYSTEM_ACTOR,
  PaymentGatewayService
};
