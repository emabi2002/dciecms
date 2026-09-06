'use strict';
const { AccessDeniedError } = require('../../../packages/rbac');
const {
  AuthenticationError,
  AuthenticationUnavailableError
} = require('../../../packages/auth');
const { NotFoundError, ConflictError, ValidationError } = require('./dciecms-service');
const { DocumentPolicyError } = require('./document-policy');
const {
  SecureDocumentNotFoundError,
  SecureDocumentConflictError
} = require('./secure-document-service');

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new ValidationError('Invalid JSON body'); }
}

function send(res, status, payload, headers = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    ...headers
  });
  res.end(data);
}

function mapError(error, res) {
  if (error instanceof AuthenticationError) {
    return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
  }
  if (error instanceof AuthenticationUnavailableError) {
    return send(res, 503, { error: 'authentication_unavailable' });
  }
  if (error instanceof AccessDeniedError) return send(res, 403, { error: 'forbidden' });
  if (error instanceof SecureDocumentNotFoundError) return send(res, 404, { error: 'not_found' });
  if (error instanceof SecureDocumentConflictError) return send(res, 409, { error: 'conflict', message: error.message });
  if (error instanceof DocumentPolicyError) return send(res, 422, { error: 'validation_error', message: error.message });
  if (error instanceof NotFoundError) return send(res, 404, { error: 'not_found' });
  if (error instanceof ConflictError) return send(res, 409, { error: 'conflict', message: error.message });
  if (error instanceof ValidationError) return send(res, 422, { error: 'validation_error', message: error.message });
  return send(res, 500, { error: 'internal_error' });
}

function createHttpApp(service, actorResolver) {
  return async function handler(req, res) {
    try {
      const actor = await actorResolver(req);
      if (!actor) return send(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url, 'http://local');
      const path = url.pathname;

      if (req.method === 'POST' && path === '/parties') return send(res, 201, await service.createParty(actor, await readJson(req)));
      if (req.method === 'POST' && path === '/filings') return send(res, 201, await service.createFilingDraft(actor, await readJson(req)));
      if (req.method === 'GET' && path === '/registry/filings') return send(res, 200, await service.listRegistryQueue(actor));
      if (req.method === 'GET' && path === '/workflow/tasks') return send(res, 200, await service.listWorkflowTasks(actor, { includeCompleted: url.searchParams.get('includeCompleted') === 'true' }));
      if (req.method === 'GET' && path === '/judicial/my-cases') return send(res, 200, await service.listMyCases(actor));
      if (req.method === 'GET' && path === '/judicial/daily-list') return send(res, 200, await service.listDailyHearings(actor, { date: url.searchParams.get('date') }));
      if (req.method === 'GET' && path === '/judicial/pending-decisions') return send(res, 200, await service.listPendingDecisions(actor));

      const judicialCaseGet = path.match(/^\/judicial\/cases\/([^/]+)$/);
      if (req.method === 'GET' && judicialCaseGet) return send(res, 200, await service.getJudicialCase(actor, judicialCaseGet[1]));
      const judicialHearingGet = path.match(/^\/judicial\/hearings\/([^/]+)$/);
      if (req.method === 'GET' && judicialHearingGet) return send(res, 200, await service.getJudicialHearing(actor, judicialHearingGet[1]));
      const judicialJudgmentGet = path.match(/^\/judicial\/judgments\/([^/]+)$/);
      if (req.method === 'GET' && judicialJudgmentGet) return send(res, 200, await service.getJudgment(actor, judicialJudgmentGet[1]));

      const documentUpload = path.match(/^\/filings\/([^/]+)\/documents\/uploads$/);
      if (req.method === 'POST' && documentUpload) {
        return send(res, 201, await service.initiateDocumentUpload(actor, documentUpload[1], await readJson(req)), { 'cache-control': 'no-store' });
      }
      const documentFinalize = path.match(/^\/documents\/([^/]+)\/finalize$/);
      if (req.method === 'POST' && documentFinalize) {
        await readJson(req);
        return send(res, 200, await service.finalizeDocumentUpload(actor, documentFinalize[1]));
      }
      const documentDownload = path.match(/^\/documents\/([^/]+)\/download-authorizations$/);
      if (req.method === 'POST' && documentDownload) {
        await readJson(req);
        return send(res, 200, await service.authorizeDocumentDownload(actor, documentDownload[1]), { 'cache-control': 'no-store' });
      }
      const documentClassification = path.match(/^\/documents\/([^/]+)\/classification$/);
      if (req.method === 'POST' && documentClassification) {
        return send(res, 200, await service.changeDocumentClassification(actor, documentClassification[1], await readJson(req)));
      }
      const documentReplacement = path.match(/^\/documents\/([^/]+)\/replacements$/);
      if (req.method === 'POST' && documentReplacement) {
        return send(res, 201, await service.createReplacementDocument(actor, documentReplacement[1], await readJson(req)), { 'cache-control': 'no-store' });
      }
      const documentSupersede = path.match(/^\/documents\/([^/]+)\/supersede$/);
      if (req.method === 'POST' && documentSupersede) {
        const body = await readJson(req);
        return send(res, 200, await service.supersedeDocument(actor, documentSupersede[1], body.replacementDocumentId, body.reason));
      }
      const documentWithdraw = path.match(/^\/documents\/([^/]+)\/withdraw$/);
      if (req.method === 'POST' && documentWithdraw) {
        const body = await readJson(req);
        return send(res, 200, await service.withdrawDocument(actor, documentWithdraw[1], body.reason));
      }
      const documentRetryScan = path.match(/^\/documents\/([^/]+)\/retry-scan$/);
      if (req.method === 'POST' && documentRetryScan) {
        await readJson(req);
        return send(res, 200, await service.retryDocumentScan(actor, documentRetryScan[1]));
      }

      const filingGet = path.match(/^\/filings\/([^/]+)$/);
      if (req.method === 'GET' && filingGet) return send(res, 200, await service.getFiling(actor, filingGet[1]));
      const docPost = path.match(/^\/filings\/([^/]+)\/documents$/);
      if (req.method === 'POST' && docPost) return send(res, 201, await service.registerDocument(actor, docPost[1], await readJson(req)));
      const submitPost = path.match(/^\/filings\/([^/]+)\/submit$/);
      if (req.method === 'POST' && submitPost) { const body = await readJson(req); return send(res, 200, await service.submitFiling(actor, submitPost[1], req.headers['idempotency-key'] || body.idempotencyKey)); }
      const validatePost = path.match(/^\/filings\/([^/]+)\/validate$/);
      if (req.method === 'POST' && validatePost) { await readJson(req); return send(res, 200, await service.validateFiling(actor, validatePost[1])); }
      const returnPost = path.match(/^\/filings\/([^/]+)\/return$/);
      if (req.method === 'POST' && returnPost) { const body = await readJson(req); return send(res, 200, await service.returnFiling(actor, returnPost[1], body.reason)); }
      const rejectPost = path.match(/^\/filings\/([^/]+)\/reject$/);
      if (req.method === 'POST' && rejectPost) { const body = await readJson(req); return send(res, 200, await service.rejectFiling(actor, rejectPost[1], body.reason)); }
      const acceptPost = path.match(/^\/filings\/([^/]+)\/accept$/);
      if (req.method === 'POST' && acceptPost) { await readJson(req); return send(res, 200, await service.acceptFiling(actor, acceptPost[1])); }
      const assessmentPost = path.match(/^\/filings\/([^/]+)\/fee-assessments$/);
      if (req.method === 'POST' && assessmentPost) return send(res, 201, await service.assessFilingFee(actor, assessmentPost[1], await readJson(req)));
      const paymentPost = path.match(/^\/fee-assessments\/([^/]+)\/payments$/);
      if (req.method === 'POST' && paymentPost) { await readJson(req); return send(res, 201, await service.createPayment(actor, paymentPost[1])); }
      const confirmPost = path.match(/^\/payments\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && confirmPost) { const body = await readJson(req); return send(res, 200, await service.confirmPayment(actor, confirmPost[1], body.providerReference)); }
      const receiptPost = path.match(/^\/payments\/([^/]+)\/receipt$/);
      if (req.method === 'POST' && receiptPost) { await readJson(req); return send(res, 201, await service.issueReceipt(actor, receiptPost[1])); }
      const reconciliationPost = path.match(/^\/payments\/([^/]+)\/reconciliations$/);
      if (req.method === 'POST' && reconciliationPost) { await readJson(req); return send(res, 201, await service.createReconciliation(actor, reconciliationPost[1])); }
      const certifyPost = path.match(/^\/reconciliations\/([^/]+)\/certify$/);
      if (req.method === 'POST' && certifyPost) { await readJson(req); return send(res, 200, await service.certifyReconciliation(actor, certifyPost[1])); }
      const openCasePost = path.match(/^\/filings\/([^/]+)\/open-case$/);
      if (req.method === 'POST' && openCasePost) { const body = await readJson(req); return send(res, 201, await service.openCase(actor, openCasePost[1], body.paymentId)); }
      const assignCasePost = path.match(/^\/cases\/([^/]+)\/assign$/);
      if (req.method === 'POST' && assignCasePost) return send(res, 200, await service.assignCase(actor, assignCasePost[1], await readJson(req)));
      const createHearingPost = path.match(/^\/cases\/([^/]+)\/hearings$/);
      if (req.method === 'POST' && createHearingPost) return send(res, 201, await service.scheduleHearing(actor, createHearingPost[1], await readJson(req)));
      const createJudgmentPost = path.match(/^\/cases\/([^/]+)\/judgments$/);
      if (req.method === 'POST' && createJudgmentPost) return send(res, 201, await service.createJudgment(actor, createJudgmentPost[1], await readJson(req)));
      const adjournHearingPost = path.match(/^\/hearings\/([^/]+)\/adjourn$/);
      if (req.method === 'POST' && adjournHearingPost) return send(res, 200, await service.adjournHearing(actor, adjournHearingPost[1], await readJson(req)));
      const startHearingPost = path.match(/^\/hearings\/([^/]+)\/start$/);
      if (req.method === 'POST' && startHearingPost) { await readJson(req); return send(res, 200, await service.startHearing(actor, startHearingPost[1])); }
      const appearancesPost = path.match(/^\/hearings\/([^/]+)\/appearances$/);
      if (req.method === 'POST' && appearancesPost) return send(res, 201, await service.recordAppearance(actor, appearancesPost[1], await readJson(req)));
      const proceedingsPost = path.match(/^\/hearings\/([^/]+)\/proceedings$/);
      if (req.method === 'POST' && proceedingsPost) return send(res, 201, await service.recordProceeding(actor, proceedingsPost[1], await readJson(req)));
      const completeHearingPost = path.match(/^\/hearings\/([^/]+)\/complete$/);
      if (req.method === 'POST' && completeHearingPost) return send(res, 200, await service.completeHearing(actor, completeHearingPost[1], await readJson(req)));
      const judgmentPut = path.match(/^\/judgments\/([^/]+)$/);
      if (req.method === 'PUT' && judgmentPut) return send(res, 200, await service.updateJudgmentDraft(actor, judgmentPut[1], await readJson(req)));
      const judgmentReview = path.match(/^\/judgments\/([^/]+)\/review$/);
      if (req.method === 'POST' && judgmentReview) { await readJson(req); return send(res, 200, await service.reviewJudgment(actor, judgmentReview[1])); }
      const judgmentSign = path.match(/^\/judgments\/([^/]+)\/sign$/);
      if (req.method === 'POST' && judgmentSign) { await readJson(req); return send(res, 200, await service.signJudgment(actor, judgmentSign[1])); }
      const judgmentIssue = path.match(/^\/judgments\/([^/]+)\/issue$/);
      if (req.method === 'POST' && judgmentIssue) { await readJson(req); return send(res, 200, await service.issueJudgment(actor, judgmentIssue[1])); }
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      return mapError(error, res);
    }
  };
}

module.exports = { createHttpApp };
