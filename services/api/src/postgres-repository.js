'use strict';

const core = require('./postgres-repository-core');
const { installSecureDocumentRepository } = require('./postgres-secure-document-repository');
const { installPaymentCallbackRepository } = require('./postgres-payment-callback-repository');

installSecureDocumentRepository(core.PostgresRepository);
installPaymentCallbackRepository(core.PostgresRepository);

module.exports = core;