import { getRuntimeConfig, type DevIdentityConfig, type RuntimeConfig } from '../config/runtime';
import type {
  AppearanceRecord,
  CaseRecord,
  DocumentMetadata,
  FeeAssessment,
  Filing,
  HearingRecord,
  JudgmentRecord,
  Payment,
  ProceedingRecord,
  Receipt,
  Reconciliation,
  WorkflowTask
} from './types';

export type ApiErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'server'
  | 'network';

export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;

  constructor(status: number, kind: ApiErrorKind, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

export type ApiRequest = {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
};

export type ApiClientConfig = Partial<RuntimeConfig> & {
  devIdentity?: DevIdentityConfig;
};

function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  return 'server';
}

function resolveConfig(overrides: ApiClientConfig = {}): RuntimeConfig {
  const runtime = getRuntimeConfig();
  return {
    baseUrl: overrides.baseUrl ?? runtime.baseUrl,
    devIdentity: overrides.devIdentity ?? runtime.devIdentity
  };
}

function buildHeaders(devIdentity?: DevIdentityConfig): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (devIdentity?.enabled) {
    headers['x-dev-sub'] = devIdentity.subject;
    headers['x-dev-roles'] = devIdentity.roles.join(',');
    headers['x-dev-courts'] = devIdentity.courtIds.join(',');
  }
  return headers;
}

async function parsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function apiRequest<T>(request: ApiRequest, config: ApiClientConfig = {}): Promise<T> {
  const resolved = resolveConfig(config);
  const url = joinUrl(resolved.baseUrl, request.path);

  try {
    const response = await fetch(url, {
      method: request.method,
      headers: buildHeaders(resolved.devIdentity),
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: request.signal
    });

    const payload = await parsePayload(response);
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
          ? payload.message
          : 'The DCIECMS service could not complete the request.';
      throw new ApiError(response.status, kindForStatus(response.status), message);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, 'network', 'Unable to reach the DCIECMS service.');
  }
}

const id = (value: string) => encodeURIComponent(value);

export function listRegistryFilings(config?: ApiClientConfig, signal?: AbortSignal) {
  return apiRequest<Filing[]>({ method: 'GET', path: '/registry/filings', signal }, config);
}

export function listWorkflowTasks(includeCompleted = false, config?: ApiClientConfig, signal?: AbortSignal) {
  const query = includeCompleted ? '?includeCompleted=true' : '';
  return apiRequest<WorkflowTask[]>({ method: 'GET', path: `/workflow/tasks${query}`, signal }, config);
}

export function getFiling(filingId: string, config?: ApiClientConfig, signal?: AbortSignal) {
  return apiRequest<Filing>({ method: 'GET', path: `/filings/${id(filingId)}`, signal }, config);
}

export function registerDocument(
  filingId: string,
  input: Pick<DocumentMetadata, 'fileName' | 'mimeType' | 'sizeBytes' | 'checksumSha256'> & { classification?: string },
  config?: ApiClientConfig
) {
  return apiRequest<DocumentMetadata>({ method: 'POST', path: `/filings/${id(filingId)}/documents`, body: input }, config);
}

export function validateFiling(filingId: string, config?: ApiClientConfig) {
  return apiRequest<Filing>({ method: 'POST', path: `/filings/${id(filingId)}/validate`, body: {} }, config);
}

export function returnFiling(filingId: string, reason: string, config?: ApiClientConfig) {
  return apiRequest<Filing>({ method: 'POST', path: `/filings/${id(filingId)}/return`, body: { reason } }, config);
}

export function rejectFiling(filingId: string, reason: string, config?: ApiClientConfig) {
  return apiRequest<Filing>({ method: 'POST', path: `/filings/${id(filingId)}/reject`, body: { reason } }, config);
}

export function acceptFiling(filingId: string, config?: ApiClientConfig) {
  return apiRequest<Filing>({ method: 'POST', path: `/filings/${id(filingId)}/accept`, body: {} }, config);
}

export function assessFee(filingId: string, amountMinor: number, currency = 'PGK', config?: ApiClientConfig) {
  return apiRequest<FeeAssessment>({ method: 'POST', path: `/filings/${id(filingId)}/fee-assessments`, body: { amountMinor, currency } }, config);
}

export function createPayment(assessmentId: string, config?: ApiClientConfig) {
  return apiRequest<Payment>({ method: 'POST', path: `/fee-assessments/${id(assessmentId)}/payments`, body: {} }, config);
}

export function confirmPayment(paymentId: string, providerReference: string, config?: ApiClientConfig) {
  return apiRequest<Payment>({ method: 'POST', path: `/payments/${id(paymentId)}/confirm`, body: { providerReference } }, config);
}

export function issueReceipt(paymentId: string, config?: ApiClientConfig) {
  return apiRequest<Receipt>({ method: 'POST', path: `/payments/${id(paymentId)}/receipt`, body: {} }, config);
}

export function createReconciliation(paymentId: string, config?: ApiClientConfig) {
  return apiRequest<Reconciliation>({ method: 'POST', path: `/payments/${id(paymentId)}/reconciliations`, body: {} }, config);
}

export function certifyReconciliation(reconciliationId: string, config?: ApiClientConfig) {
  return apiRequest<Reconciliation>({ method: 'POST', path: `/reconciliations/${id(reconciliationId)}/certify`, body: {} }, config);
}

export function openCase(filingId: string, paymentId: string, config?: ApiClientConfig) {
  return apiRequest<CaseRecord>({ method: 'POST', path: `/filings/${id(filingId)}/open-case`, body: { paymentId } }, config);
}

export function listMyCases(config?: ApiClientConfig, signal?: AbortSignal) {
  return apiRequest<CaseRecord[]>({ method: 'GET', path: '/judicial/my-cases', signal }, config);
}

export function getJudicialCase(caseId: string, config?: ApiClientConfig, signal?: AbortSignal) {
  return apiRequest<CaseRecord>({ method: 'GET', path: `/judicial/cases/${id(caseId)}`, signal }, config);
}

export function assignCase(caseId: string, assigneeSubject: string, config?: ApiClientConfig) {
  return apiRequest<CaseRecord>({ method: 'POST', path: `/cases/${id(caseId)}/assign`, body: { assigneeSubject } }, config);
}

export function listDailyHearings(date: string, config?: ApiClientConfig, signal?: AbortSignal) {
  return apiRequest<HearingRecord[]>({ method: 'GET', path: `/judicial/daily-list?date=${encodeURIComponent(date)}`, signal }, config);
}

export function getJudicialHearing(hearingId: string, config?: ApiClientConfig, signal?: AbortSignal) {
  return apiRequest<HearingRecord>({ method: 'GET', path: `/judicial/hearings/${id(hearingId)}`, signal }, config);
}

export function scheduleHearing(
  caseId: string,
  input: Pick<HearingRecord, 'hearingType' | 'scheduledStart' | 'scheduledEnd'> & { courtroom?: string | null },
  config?: ApiClientConfig
) {
  return apiRequest<HearingRecord>({ method: 'POST', path: `/cases/${id(caseId)}/hearings`, body: input }, config);
}

export function adjournHearing(
  hearingId: string,
  input: { reason: string; nextStart?: string; nextEnd?: string },
  config?: ApiClientConfig
) {
  return apiRequest<HearingRecord>({ method: 'POST', path: `/hearings/${id(hearingId)}/adjourn`, body: input }, config);
}

export function startHearing(hearingId: string, config?: ApiClientConfig) {
  return apiRequest<HearingRecord>({ method: 'POST', path: `/hearings/${id(hearingId)}/start`, body: {} }, config);
}

export function recordAppearance(
  hearingId: string,
  input: Pick<AppearanceRecord, 'participantName' | 'participantRole' | 'appearanceMode'>,
  config?: ApiClientConfig
) {
  return apiRequest<AppearanceRecord>({ method: 'POST', path: `/hearings/${id(hearingId)}/appearances`, body: input }, config);
}

export function recordProceeding(
  hearingId: string,
  input: { note?: string; recordReference?: string },
  config?: ApiClientConfig
) {
  return apiRequest<ProceedingRecord>({ method: 'POST', path: `/hearings/${id(hearingId)}/proceedings`, body: input }, config);
}

export function completeHearing(hearingId: string, outcomeCode: string, config?: ApiClientConfig) {
  return apiRequest<HearingRecord>({ method: 'POST', path: `/hearings/${id(hearingId)}/complete`, body: { outcomeCode } }, config);
}

export function createJudgment(
  caseId: string,
  input: Pick<JudgmentRecord, 'hearingId' | 'decisionType' | 'title' | 'content'>,
  config?: ApiClientConfig
) {
  return apiRequest<JudgmentRecord>({ method: 'POST', path: `/cases/${id(caseId)}/judgments`, body: input }, config);
}

export function getJudgment(judgmentId: string, config?: ApiClientConfig, signal?: AbortSignal) {
  return apiRequest<JudgmentRecord>({ method: 'GET', path: `/judicial/judgments/${id(judgmentId)}`, signal }, config);
}

export function listPendingDecisions(config?: ApiClientConfig, signal?: AbortSignal) {
  return apiRequest<JudgmentRecord[]>({ method: 'GET', path: '/judicial/pending-decisions', signal }, config);
}

export function updateJudgmentDraft(
  judgmentId: string,
  input: Pick<JudgmentRecord, 'title' | 'content'>,
  config?: ApiClientConfig
) {
  return apiRequest<JudgmentRecord>({ method: 'PUT', path: `/judgments/${id(judgmentId)}`, body: input }, config);
}

export function reviewJudgment(judgmentId: string, config?: ApiClientConfig) {
  return apiRequest<JudgmentRecord>({ method: 'POST', path: `/judgments/${id(judgmentId)}/review`, body: {} }, config);
}

export function signJudgment(judgmentId: string, config?: ApiClientConfig) {
  return apiRequest<JudgmentRecord>({ method: 'POST', path: `/judgments/${id(judgmentId)}/sign`, body: {} }, config);
}

export function issueJudgment(judgmentId: string, config?: ApiClientConfig) {
  return apiRequest<JudgmentRecord>({ method: 'POST', path: `/judgments/${id(judgmentId)}/issue`, body: {} }, config);
}
