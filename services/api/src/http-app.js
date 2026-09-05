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
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      return mapError(error, res);
    }
  };
}

module.exports = { createHttpApp };
