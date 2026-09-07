'use strict';

const core = require('./postgres-repository-core');
const { installSecureDocumentRepository } = require('./postgres-secure-document-repository');
const { installPaymentGatewayRepository } = require('./postgres-payment-gateway-repository');

installSecureDocumentRepository(core.PostgresRepository);
installPaymentGatewayRepository(core.PostgresRepository);

module.exports = core;
