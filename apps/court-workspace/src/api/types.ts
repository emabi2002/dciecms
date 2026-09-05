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
  status: string;
  openedAt?: string;
};
