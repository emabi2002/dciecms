'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthenticationError } = require('../../packages/auth');
const { createOidcActorResolver } = require('../../services/api/src/oidc-actor-resolver');

const CONFIG = Object.freeze({
  mode: 'oidc',
  issuer: 'https://identity.example.test',
  audience: 'dciecms-api',
  jwksUri: 'https://identity.example.test/.well-known/jwks.json',
  algorithms: ['RS256']
});

test('production bearer token requires an expiration claim', async () => {
  const jose = await import('jose');
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const publicJwk = await jose.exportJWK(publicKey);
  Object.assign(publicJwk, { kid: 'key-exp', alg: 'RS256', use: 'sig' });

  const resolver = await createOidcActorResolver(CONFIG, {
    joseModule: jose,
    keyResolver: jose.createLocalJWKSet({ keys: [publicJwk] })
  });

  const token = await new jose.SignJWT({ roles: ['REG'], court_ids: ['COURT-A'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-exp' })
    .setIssuer(CONFIG.issuer)
    .setAudience(CONFIG.audience)
    .setSubject('u-1')
    .setIssuedAt()
    .sign(privateKey);

  await assert.rejects(
    () => resolver({ headers: { authorization: `Bearer ${token}` } }),
    AuthenticationError
  );
});
