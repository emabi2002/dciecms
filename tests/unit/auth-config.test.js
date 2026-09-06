'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAuthenticationConfig } = require('../../services/api/src/auth-config');
const { createAuthenticationResolver } = require('../../services/api/src/auth-runtime');

const oidcEnv = {
  NODE_ENV: 'production',
  DCIECMS_AUTH_MODE: 'oidc',
  DCIECMS_OIDC_ISSUER: 'https://identity.example.test',
  DCIECMS_OIDC_AUDIENCE: 'dciecms-api',
  DCIECMS_OIDC_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
  DCIECMS_OIDC_ALLOWED_ALGS: 'RS256,ES256'
};

test('authentication mode is mandatory', () => {
  assert.throws(() => loadAuthenticationConfig({ NODE_ENV: 'development' }), /DCIECMS_AUTH_MODE/);
});

test('development authentication is forbidden in production', () => {
  assert.throws(
    () => loadAuthenticationConfig({ NODE_ENV: 'production', DCIECMS_AUTH_MODE: 'development' }),
    /development.*production/i
  );
});

test('unknown authentication mode is rejected', () => {
  assert.throws(() => loadAuthenticationConfig({ DCIECMS_AUTH_MODE: 'magic' }), /mode/i);
});

test('oidc mode requires complete configuration', () => {
  for (const key of [
    'DCIECMS_OIDC_ISSUER',
    'DCIECMS_OIDC_AUDIENCE',
    'DCIECMS_OIDC_JWKS_URI',
    'DCIECMS_OIDC_ALLOWED_ALGS'
  ]) {
    const env = { ...oidcEnv };
    delete env[key];
    assert.throws(() => loadAuthenticationConfig(env), new RegExp(key));
  }
});

test('oidc mode rejects symmetric and none algorithms', () => {
  assert.throws(
    () => loadAuthenticationConfig({ ...oidcEnv, DCIECMS_OIDC_ALLOWED_ALGS: 'RS256,HS256' }),
    /algorithm/i
  );
  assert.throws(
    () => loadAuthenticationConfig({ ...oidcEnv, DCIECMS_OIDC_ALLOWED_ALGS: 'none' }),
    /algorithm/i
  );
});

test('oidc issuer and jwks URLs must use https', () => {
  assert.throws(
    () => loadAuthenticationConfig({ ...oidcEnv, DCIECMS_OIDC_ISSUER: 'http://identity.example.test' }),
    /https/i
  );
  assert.throws(
    () => loadAuthenticationConfig({ ...oidcEnv, DCIECMS_OIDC_JWKS_URI: 'http://identity.example.test/jwks' }),
    /https/i
  );
});

test('valid oidc configuration preserves exact issuer and jwks strings', () => {
  const env = {
    ...oidcEnv,
    DCIECMS_OIDC_ISSUER: 'https://identity.example.test/tenant/',
    DCIECMS_OIDC_JWKS_URI: 'https://identity.example.test/tenant/jwks/'
  };
  assert.deepEqual(loadAuthenticationConfig(env), {
    mode: 'oidc',
    issuer: 'https://identity.example.test/tenant/',
    audience: 'dciecms-api',
    jwksUri: 'https://identity.example.test/tenant/jwks/',
    algorithms: ['RS256', 'ES256']
  });
});

test('runtime selects development resolver only in explicit development mode', async () => {
  const resolver = await createAuthenticationResolver({ DCIECMS_AUTH_MODE: 'development' });
  const actor = resolver({ headers: {
    'x-dev-sub': 'reg-a',
    'x-dev-roles': 'REG',
    'x-dev-courts': 'COURT-A'
  }});
  assert.equal(actor.userId, 'reg-a');
});

test('runtime constructs oidc resolver from oidc configuration', async () => {
  let received;
  const resolver = await createAuthenticationResolver(oidcEnv, {
    createOidcActorResolver: async config => {
      received = config;
      return () => ({ userId: 'verified' });
    }
  });
  assert.equal(received.mode, 'oidc');
  assert.equal(resolver({ headers: {} }).userId, 'verified');
});

test('runtime does not fall back when oidc resolver construction fails', async () => {
  await assert.rejects(
    () => createAuthenticationResolver(oidcEnv, {
      createOidcActorResolver: async () => { throw new Error('verifier construction failed'); }
    }),
    /verifier construction failed/
  );
});
