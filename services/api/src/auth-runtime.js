'use strict';
const { resolveActorFromClaims } = require('../../../packages/auth');
const { loadAuthenticationConfig } = require('./auth-config');

function csvHeader(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function developmentActorResolver(req) {
  const sub = req.headers['x-dev-sub'];
  if (!sub) return null;
  return resolveActorFromClaims({
    sub,
    roles: csvHeader(req.headers['x-dev-roles']),
    court_ids: csvHeader(req.headers['x-dev-courts']),
    explicit_grants: csvHeader(req.headers['x-dev-grants'])
  });
}

async function createAuthenticationResolver(env = process.env, dependencies = {}) {
  const config = loadAuthenticationConfig(env);
  if (config.mode === 'development') return developmentActorResolver;
  const factory = dependencies.createOidcActorResolver || require('./oidc-actor-resolver').createOidcActorResolver;
  return factory(config, dependencies);
}

module.exports = { developmentActorResolver, createAuthenticationResolver };
