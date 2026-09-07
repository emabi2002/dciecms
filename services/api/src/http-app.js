'use strict';

const { createHash } = require('node:crypto');
const { createHttpApp: createAuthenticatedHttpApp } = require('./http-app-authenticated');
const { PaymentGatewayVerificationError } = require('./payment-gateway-verifier');

const PAYMENT_CALLBACK_PATH = '/api/integrations/payments/callback';
const DEFAULT_PAYMENT_CALLBACK_MAX_BODY_BYTES = 256 * 1024;

function send(res, status, payload, headers = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'content-length':Buffer.byteLength(data),
    ...headers
  });
  res.end(data);
}

async function readRawBody(req, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      tooLarge = true;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }

  if (tooLarge) {
    throw new PaymentGatewayVerificationError('Payment callback body exceeds the allowed size', {
      statusCode:413,
      code:'PAYMENT_CALLBACK_BODY_TOO_LARGE'
    });
  }
  return Buffer.concat(chunks, size);
}

function callbackErrorResponse(error, res) {
  if (error?.code === 'PAYMENT_CALLBACK_EVIDENCE_CONFLICT' || error?.code === 'PAYMENT_CALLBACK_STATE_CONFLICT') {
    return send(res, 409, { error:'payment_callback_conflict' });
  }

  const classified = error instanceof PaymentGatewayVerificationError ||
    (typeof error?.code === 'string' && error.code.startsWith('PAYMENT_CALLBACK_'));

  if (classified) {
    if (error.statusCode === 401) return send(res, 401, { error:'payment_callback_unauthorized' });
    if (error.statusCode === 400) return send(res, 400, { error:'payment_callback_invalid' });
    if (error.statusCode === 413) return send(res, 413, { error:'payment_callback_too_large' });
    if (error.statusCode === 503) return send(res, 503, { error:'payment_callback_unavailable' });
  }

  return send(res, 500, { error:'internal_error' });
}

function boundedFailureCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._:-]{0,79}$/.test(code) ? code : 'PAYMENT_CALLBACK_REJECTED';
}

function createHttpApp(service, actorResolver, {
  paymentGatewayVerifier = null,
  paymentGatewayService = null,
  paymentGatewayMaxBodyBytes = DEFAULT_PAYMENT_CALLBACK_MAX_BODY_BYTES
} = {}) {
  if (!Number.isSafeInteger(paymentGatewayMaxBodyBytes) || paymentGatewayMaxBodyBytes < 1) {
    throw new TypeError('paymentGatewayMaxBodyBytes must be a positive safe integer');
  }

  const authenticatedHandler = createAuthenticatedHttpApp(service, actorResolver);

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const isPaymentCallback = req.method === 'POST' && url.pathname === PAYMENT_CALLBACK_PATH;

    if (!isPaymentCallback) return authenticatedHandler(req, res);

    if (!paymentGatewayVerifier || typeof paymentGatewayVerifier.verify !== 'function' ||
        !paymentGatewayService || typeof paymentGatewayService.processVerifiedCallback !== 'function') {
      return send(res, 404, { error:'not_found' });
    }

    try {
      const receivedAt = new Date().toISOString();
      const rawBody = await readRawBody(req, paymentGatewayMaxBodyBytes);
      const verifiedCallback = await paymentGatewayVerifier.verify({
        rawBody,
        headers:req.headers,
        receivedAt
      });
      const payloadDigestSha256 = createHash('sha256').update(rawBody).digest('hex');
      const result = await paymentGatewayService.processVerifiedCallback({
        verifiedCallback,
        payloadDigestSha256,
        receivedAt
      });

      if (result?.status === 'REJECTED') {
        return send(res, 409, {
          error:'payment_callback_rejected',
          failureCode:boundedFailureCode(result.failureCode)
        });
      }
      return send(res, 200, result);
    } catch (error) {
      return callbackErrorResponse(error, res);
    }
  };
}

module.exports = {
  createHttpApp,
  PAYMENT_CALLBACK_PATH,
  DEFAULT_PAYMENT_CALLBACK_MAX_BODY_BYTES
};
