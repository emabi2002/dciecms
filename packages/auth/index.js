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

module.exports = { resolveActorFromClaims };
