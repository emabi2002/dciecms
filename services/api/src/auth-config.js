'use strict';

const ASYMMETRIC_ALGORITHMS = new Set([
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA'
]);

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function absoluteHttpsUrl(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be an absolute URL`); }
  if (parsed.protocol !== 'https:') throw new Error(`${name} must use https`);
  return value;
}

function loadAuthenticationConfig(env = process.env) {
  const mode = required(env, 'DCIECMS_AUTH_MODE').toLowerCase();

  if (mode === 'development') {
    if (env.NODE_ENV === 'production') {
      throw new Error('development authentication mode is forbidden in production');
    }
    return Object.freeze({ mode: 'development' });
  }

  if (mode !== 'oidc') throw new Error(`Unsupported authentication mode: ${mode}`);

  const algorithms = required(env, 'DCIECMS_OIDC_ALLOWED_ALGS')
    .split(',').map(value => value.trim()).filter(Boolean);
  if (!algorithms.length || algorithms.some(alg => !ASYMMETRIC_ALGORITHMS.has(alg))) {
    throw new Error('OIDC signing algorithm allow-list contains an unsupported algorithm');
  }

  return Object.freeze({
    mode: 'oidc',
    issuer: absoluteHttpsUrl(required(env, 'DCIECMS_OIDC_ISSUER'), 'DCIECMS_OIDC_ISSUER'),
    audience: required(env, 'DCIECMS_OIDC_AUDIENCE'),
    jwksUri: absoluteHttpsUrl(required(env, 'DCIECMS_OIDC_JWKS_URI'), 'DCIECMS_OIDC_JWKS_URI'),
    algorithms: Object.freeze([...new Set(algorithms)])
  });
}

module.exports = { loadAuthenticationConfig };
