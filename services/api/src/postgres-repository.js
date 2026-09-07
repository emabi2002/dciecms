'use strict';

const core = require('./postgres-repository-core');
const { installSecureDocumentRepository } = require('./postgres-secure-document-repository');
const { installPaymentIntegrationRepository } = require('./postgres-payment-integration-repository');
const { installCaseLifecycleRecordsRepository } = require('./postgres-case-lifecycle-records-repository');

installSecureDocumentRepository(core.PostgresRepository);
installPaymentIntegrationRepository(core.PostgresRepository);
installCaseLifecycleRecordsRepository(core.PostgresRepository);

module.exports = core;
