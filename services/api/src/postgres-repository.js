'use strict';

const core = require('./postgres-repository-core');
const { installSecureDocumentRepository } = require('./postgres-secure-document-repository');
const { installPaymentIntegrationRepository } = require('./postgres-payment-integration-repository');
const { installCaseLifecycleRecordsRepository } = require('./postgres-case-lifecycle-records-repository');
const { installFinanceCompletionRepository } = require('./postgres-finance-completion-repository');
const { installR3FinanceWorkbenchRepository } = require('./postgres-r3-finance-workbench-repository');

installSecureDocumentRepository(core.PostgresRepository);
installPaymentIntegrationRepository(core.PostgresRepository);
installCaseLifecycleRecordsRepository(core.PostgresRepository);
installFinanceCompletionRepository(core.PostgresRepository);
installR3FinanceWorkbenchRepository(core.PostgresRepository);

module.exports = core;
