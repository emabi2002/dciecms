'use strict';

const core = require('./postgres-repository-core');
const { installSecureDocumentRepository } = require('./postgres-secure-document-repository');

installSecureDocumentRepository(core.PostgresRepository);

module.exports = core;
