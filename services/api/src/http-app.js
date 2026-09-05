'use strict';
const { AccessDeniedError } = require('../../../packages/rbac');
const { NotFoundError, ConflictError, ValidationError } = require('./dciecms-service');

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new ValidationError('Invalid JSON body'); }
}

function send(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function mapError(error, res) {
  if (error instanceof AccessDeniedError) return send(res, 403, { error: 'forbidden' });
  if (error instanceof NotFoundError) return send(res, 404, { error: 'not_found' });
  if (error instanceof ConflictError) return send(res, 409, { error: 'conflict', message: error.message });
  if (error instanceof ValidationError) return send(res, 422, { error: 'validation_error', message: error.message });
  return send(res, 500, { error: 'internal_error' });
}

function createHttpApp(service, actorResolver) {
  return async function handler(req, res) {
    try {
      const actor = actorResolver(req);
      if (!actor) return send(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url, 'http://local');
      const path = url.pathname;

      if (req.method === 'POST' && path === '/parties') {
        return send(res, 201, await service.createParty(actor, await readJson(req)));
      }
      if (req.method === 'POST' && path === '/filings') {
        return send(res, 201, await service.createFilingDraft(actor, await readJson(req)));
      }
      if (req.method === 'GET' && path === '/registry/filings') {
        return send(res, 200, await service.listRegistryQueue(actor));
      }
      if (req.method === 'GET' && path === '/workflow/tasks') {
        return send(res, 200, await service.listWorkflowTasks(actor, { includeCompleted: url.searchParams.get('includeCompleted') === 'true' }));
      }

      const filingGet = path.match(/^\/filings\/([^/]+)$/);
      if (req.method === 'GET' && filingGet) {
        return send(res, 200, await service.getFiling(actor, filingGet[1]));
      }
      const docPost = path.match(/^\/filings\/([^/]+)\/documents$/);
      if (req.method === 'POST' && docPost) {
        return send(res, 201, await service.registerDocument(actor, docPost[1], await readJson(req)));
      }
      const submitPost = path.match(/^\/filings\/([^/]+)\/submit$/);
      if (req.method === 'POST' && submitPost) {
        const body = await readJson(req);
        return send(res, 200, await service.submitFiling(actor, submitPost[1], req.headers['idempotency-key'] || body.idempotencyKey));
      }
      const validatePost = path.match(/^\/filings\/([^/]+)\/validate$/);
      if (req.method === 'POST' && validatePost) {
        await readJson(req);
        return send(res, 200, await service.validateFiling(actor, validatePost[1]));
      }
      const returnPost = path.match(/^\/filings\/([^/]+)\/return$/);
      if (req.method === 'POST' && returnPost) {
        const body = await readJson(req);
        return send(res, 200, await service.returnFiling(actor, returnPost[1], body.reason));
      }
      const rejectPost = path.match(/^\/filings\/([^/]+)\/reject$/);
      if (req.method === 'POST' && rejectPost) {
        const body = await readJson(req);
        return send(res, 200, await service.rejectFiling(actor, rejectPost[1], body.reason));
      }
      const acceptPost = path.match(/^\/filings\/([^/]+)\/accept$/);
      if (req.method === 'POST' && acceptPost) {
        await readJson(req);
        return send(res, 200, await service.acceptFiling(actor, acceptPost[1]));
      }
      const assessmentPost = path.match(/^\/filings\/([^/]+)\/fee-assessments$/);
      if (req.method === 'POST' && assessmentPost) {
        return send(res, 201, await service.assessFilingFee(actor, assessmentPost[1], await readJson(req)));
      }
      const paymentPost = path.match(/^\/fee-assessments\/([^/]+)\/payments$/);
      if (req.method === 'POST' && paymentPost) {
        await readJson(req);
        return send(res, 201, await service.createPayment(actor, paymentPost[1]));
      }
      const confirmPost = path.match(/^\/payments\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && confirmPost) {
        const body = await readJson(req);
        return send(res, 200, await service.confirmPayment(actor, confirmPost[1], body.providerReference));
      }
      const receiptPost = path.match(/^\/payments\/([^/]+)\/receipt$/);
      if (req.method === 'POST' && receiptPost) {
        await readJson(req);
        return send(res, 201, await service.issueReceipt(actor, receiptPost[1]));
      }
      const reconciliationPost = path.match(/^\/payments\/([^/]+)\/reconciliations$/);
      if (req.method === 'POST' && reconciliationPost) {
        await readJson(req);
        return send(res, 201, await service.createReconciliation(actor, reconciliationPost[1]));
      }
      const certifyPost = path.match(/^\/reconciliations\/([^/]+)\/certify$/);
      if (req.method === 'POST' && certifyPost) {
        await readJson(req);
        return send(res, 200, await service.certifyReconciliation(actor, certifyPost[1]));
      }
      const openCasePost = path.match(/^\/filings\/([^/]+)\/open-case$/);
      if (req.method === 'POST' && openCasePost) {
        const body = await readJson(req);
        return send(res, 201, await service.openCase(actor, openCasePost[1], body.paymentId));
      }
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      return mapError(error, res);
    }
  };
}

module.exports = { createHttpApp };
