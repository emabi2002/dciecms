export type Filing = {
  filingId: string;
  filingReference: string;
  courtId: string;
  caseTypeCode: string;
  filerPartyId: string;
  status: string;
  createdAt?: string;
  submittedAt?: string | null;
  validatedAt?: string | null;
  decisionReason?: string | null;
  decisionBy?: string | null;
  decisionAt?: string | null;
};

export type WorkflowTask = {
  taskId: string;
  filingId: string;
  courtId: string;
  taskType: string;
  assignedRole: string;
  priority: string;
  status: string;
  dueAt?: string | null;
  createdAt?: string;
};

export type DocumentMetadata = {
  documentId: string;
  filingId: string;
  courtId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  status: string;
  classification: string;
  createdAt?: string;
};

export type FeeAssessment = {
  assessmentId: string;
  filingId: string;
  courtId: string;
  amountMinor: number;
  currency: string;
  status: string;
  createdAt?: string;
};

export type Payment = {
  paymentId: string;
  assessmentId: string;
  courtId: string;
  amountMinor: number;
  currency: string;
  status: string;
  providerReference?: string | null;
  confirmedAt?: string | null;
};

export type Receipt = {
  receiptId: string;
  paymentId: string;
  courtId: string;
  receiptNumber: string;
  status: string;
  issuedAt?: string;
};

export type Reconciliation = {
  reconciliationId: string;
  paymentId: string;
  courtId: string;
  status: string;
  createdBy?: string;
  certifiedBy?: string | null;
  certifiedAt?: string | null;
};

export type CaseRecord = {
  caseId: string;
  filingId: string;
  courtId: string;
  caseNumber: string;
  caseTypeCode?: string;
  status: string;
  openedAt?: string;
  assignedToSubject?: string | null;
  assignedBySubject?: string | null;
  assignedAt?: string | null;
};

export type HearingRecord = {
  hearingId: string;
  caseId: string;
  courtId: string;
  hearingType: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  courtroom?: string | null;
  scheduledBy?: string;
  createdAt?: string;
  adjournedBy?: string | null;
  adjournedAt?: string | null;
  adjournmentReason?: string | null;
  startedBy?: string | null;
  startedAt?: string | null;
  completedBy?: string | null;
  completedAt?: string | null;
  outcomeCode?: string | null;
  nextHearing?: HearingRecord | null;
};

export type AppearanceRecord = {
  appearanceId: string;
  hearingId: string;
  caseId: string;
  courtId: string;
  participantName: string;
  participantRole: string;
  appearanceMode: string;
  recordedBy: string;
  recordedAt: string;
};

export type ProceedingRecord = {
  proceedingId: string;
  hearingId: string;
  caseId: string;
  courtId: string;
  note?: string | null;
  recordReference?: string | null;
  recordedBy: string;
  recordedAt: string;
};

export type JudgmentRecord = {
  judgmentId: string;
  caseId: string;
  hearingId: string;
  courtId: string;
  decisionType: string;
  title: string;
  content: string;
  status: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy?: string | null;
  updatedAt?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  signedBy?: string | null;
  signedAt?: string | null;
  issuedBy?: string | null;
  issuedAt?: string | null;
};
