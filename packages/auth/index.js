const { AuthenticationError, AuthenticationUnavailableError } = require('./errors');

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function resolveActorFromClaims(claims = {}) {
  if (!claims.sub) throw new Error('Identity subject is required');
  return Object.freeze({
    userId: String(claims.sub),
    roles: Object.freeze(unique((claims.roles || []).map(r => String(r).toUpperCase()))),
    courtIds: Object.freeze(unique((claims.court_ids || []).map(String))),
    explicitGrants: Object.freeze(unique((claims.explicit_grants || []).map(String)))
  });
}

function stringArrayClaim(claims, name) {
  const value = claims[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new AuthenticationError();
  }
  return value;
}

function resolveActorFromVerifiedClaims(claims) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new AuthenticationError();
  }
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) {
    throw new AuthenticationError();
  }
  return resolveActorFromClaims({
    sub: claims.sub,
    roles: stringArrayClaim(claims, 'roles'),
    court_ids: stringArrayClaim(claims, 'court_ids'),
    explicit_grants: stringArrayClaim(claims, 'explicit_grants')
  });
}

module.exports = {
  resolveActorFromClaims,
  resolveActorFromVerifiedClaims,
  AuthenticationError,
  AuthenticationUnavailableError
};
