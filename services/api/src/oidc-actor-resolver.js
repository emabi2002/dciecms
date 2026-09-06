'use strict';
const {
  resolveActorFromVerifiedClaims,
  AuthenticationError,
  AuthenticationUnavailableError
} = require('../../../packages/auth');

function bearerToken(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') throw new AuthenticationError();
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  if (!match) throw new AuthenticationError();
  return match[1];
}

function createJwksFetch(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('JWKS fetch implementation is required');
  return async function jwksFetch(url, options) {
    try {
      const response = await fetchImpl(url, options);
      if (!response.ok) throw new AuthenticationUnavailableError();
      return response;
    } catch (error) {
      if (error instanceof AuthenticationUnavailableError) throw error;
      throw new AuthenticationUnavailableError();
    }
  };
}

function isVerificationError(error, jose) {
  if (error instanceof jose.errors.JOSEError) return true;
  return typeof error?.code === 'string' && (
    error.code.startsWith('ERR_JWT_') ||
    error.code.startsWith('ERR_JWS_') ||
    error.code.startsWith('ERR_JWKS_') ||
    error.code.startsWith('ERR_JOSE_')
  );
}

async function createOidcActorResolver(config, dependencies = {}) {
  const jose = dependencies.joseModule || await import('jose');
  const keyResolver = dependencies.keyResolver || jose.createRemoteJWKSet(
    new URL(config.jwksUri),
    {
      cacheMaxAge: 600_000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
      [jose.customFetch]: createJwksFetch(dependencies.fetchImpl || globalThis.fetch)
    }
  );

  return async function oidcActorResolver(req) {
    const token = bearerToken(req);
    try {
      const { payload } = await jose.jwtVerify(token, keyResolver, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: config.algorithms,
        requiredClaims: ['exp']
      });
      return resolveActorFromVerifiedClaims(payload);
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof AuthenticationUnavailableError) throw error;
      if (error?.code === 'ERR_JWKS_TIMEOUT') throw new AuthenticationUnavailableError();
      if (isVerificationError(error, jose)) throw new AuthenticationError();
      throw error;
    }
  };
}

module.exports = { createJwksFetch, createOidcActorResolver };
