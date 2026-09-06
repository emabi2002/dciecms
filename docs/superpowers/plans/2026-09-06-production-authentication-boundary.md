# DCIECMS Production Authentication Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral, fail-closed OIDC/JWT bearer-token authentication boundary that verifies signed access tokens before mapping verified claims into the existing DCIECMS actor/RBAC model.

**Architecture:** Keep `resolveActorFromClaims()` as the canonical actor normalizer, add strict verified-claim validation before it, and create a production OIDC resolver that uses `jose` with one cached remote JWKS resolver per process. The HTTP adapter will await authentication, map sanitized 401/503/500 outcomes, and preserve 403 for authorization failures; the Court Workspace will gain an injected bearer-token provider without implementing an IdP login flow.

**Tech Stack:** Node.js >=20, CommonJS backend, `jose` 6.x loaded with dynamic `import()`, Node `http`, Node test runner, React 18, TypeScript 5.9, Vite/Vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-production-authentication-boundary-design.md`

## Global Constraints

- Production identity is accepted only from `Authorization: Bearer <token>` when `DCIECMS_AUTH_MODE=oidc`.
- Verify JWT signature, exact issuer, required audience, `exp`, `nbf`, and an explicit asymmetric signing-algorithm allow-list before any authorization claim is trusted.
- Verified authorization claims are `sub`, `roles`, `court_ids`, and `explicit_grants`; malformed claim types fail authentication.
- `x-dev-*` identity headers remain development-only and are never read by the OIDC resolver.
- `DCIECMS_AUTH_MODE` is explicit; unknown/missing mode fails startup and `development` mode is forbidden when `NODE_ENV=production`.
- OIDC configuration is fail-closed: issuer, audience, JWKS URI, and allowed algorithms are mandatory.
- Authentication failures return sanitized 401; authenticated authorization failures remain 403; safely identified JWKS infrastructure failures return 503; unexpected internal failures remain sanitized 500.
- Bearer tokens, signing keys, and raw claims must not be written to errors, logs, audit metadata, outbox payloads, or domain records.
- The Court Workspace receives an access token through an injected provider; this workstream does not implement browser login, PKCE, refresh tokens, or logout federation.
- No production IdP registration, credentials, live authentication activation, production deployment, DNS change, or live database migration is part of this plan.
- Use RED -> GREEN TDD and frequent commits. Merge only after exact-head CI and security review are green.

---

## File Map

### Create

- `packages/auth/errors.js` — authentication-domain error types shared by verifier and HTTP adapter.
- `services/api/src/auth-config.js` — strict environment parsing and authentication-mode configuration.
- `services/api/src/oidc-actor-resolver.js` — bearer extraction, remote JWKS construction, JWT verification, safe error classification, verified-claim actor mapping.
- `services/api/src/auth-runtime.js` — selects development vs OIDC resolver and enforces the production boundary.
- `tests/security/production-authentication.test.js` — cryptographic token/JWKS security regression suite.
- `tests/unit/auth-config.test.js` — fail-closed configuration and mode-selection tests.

### Modify

- `packages/auth/index.js` — add strict `resolveActorFromVerifiedClaims()` while preserving existing `resolveActorFromClaims()` behavior.
- `services/api/src/http-app.js` — await async actor resolvers and map authentication-specific failures.
- `services/api/src/server.js` — construct the configured authentication resolver before listening.
- `tests/unit/auth-rbac.test.js` — verified-claim shape tests.
- `tests/api/http-app.test.js` — 401/403/503 and async-resolver integration tests.
- `package.json` — add `jose` 6.x backend dependency.
- `apps/court-workspace/src/api/client.ts` — injected bearer-token provider and no dev fallback.
- `apps/court-workspace/src/api/client.test.ts` — bearer header, mutual exclusion, no-fallback tests.
- `.env.example` — explicit development/OIDC authentication settings without real credentials.
- `docs/runbooks/LOCAL_DEVELOPMENT.md` — explicit development-mode startup instructions.
- `README.md` — production authentication boundary status and non-goals.
- `docs/architecture/IMPLEMENTATION_STATUS.md` — mark the provider-neutral code boundary implemented while leaving live IdP integration outstanding.

---

### Task 1: Strict verified-claim contract and authentication errors

**Files:**
- Create: `packages/auth/errors.js`
- Modify: `packages/auth/index.js`
- Modify/Test: `tests/unit/auth-rbac.test.js`

**Interfaces:**
- Consumes: existing `resolveActorFromClaims(claims)`.
- Produces: `AuthenticationError`, `AuthenticationUnavailableError`, and `resolveActorFromVerifiedClaims(claims)`.

- [ ] **Step 1: Add RED tests for verified claim shapes**

Append tests equivalent to:

```js
const {
  resolveActorFromClaims,
  resolveActorFromVerifiedClaims,
  AuthenticationError
} = require('../../packages/auth');

test('verified claims require a non-empty string subject', () => {
  assert.throws(() => resolveActorFromVerifiedClaims({ sub: 123, roles: [] }), AuthenticationError);
  assert.throws(() => resolveActorFromVerifiedClaims({ sub: '   ', roles: [] }), AuthenticationError);
});

test('verified authorization claims must be arrays of non-empty strings', () => {
  for (const [name, value] of [
    ['roles', 'REG'],
    ['court_ids', [123]],
    ['explicit_grants', ['']]
  ]) {
    assert.throws(
      () => resolveActorFromVerifiedClaims({ sub: 'u-1', [name]: value }),
      AuthenticationError
    );
  }
});

test('verified claims preserve canonical actor normalization', () => {
  const actor = resolveActorFromVerifiedClaims({
    sub: 'u-1',
    roles: ['reg', 'REG'],
    court_ids: ['COURT-A', 'COURT-A'],
    explicit_grants: ['case:CASE-9', 'case:CASE-9']
  });
  assert.deepEqual(actor, {
    userId: 'u-1',
    roles: ['REG'],
    courtIds: ['COURT-A'],
    explicitGrants: ['case:CASE-9']
  });
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run:

```bash
node --test tests/unit/auth-rbac.test.js
```

Expected: FAIL because `resolveActorFromVerifiedClaims` and `AuthenticationError` do not exist yet.

- [ ] **Step 3: Add authentication error types**

Create `packages/auth/errors.js`:

```js
'use strict';

class AuthenticationError extends Error {
  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

class AuthenticationUnavailableError extends Error {
  constructor(message = 'Authentication service unavailable') {
    super(message);
    this.name = 'AuthenticationUnavailableError';
  }
}

module.exports = { AuthenticationError, AuthenticationUnavailableError };
```

- [ ] **Step 4: Add strict verified-claim validation before actor normalization**

Modify `packages/auth/index.js` so `resolveActorFromClaims()` remains backward-compatible for existing trusted development/test callers, while the new production path is strict:

```js
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
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new AuthenticationError();
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) throw new AuthenticationError();
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
```

- [ ] **Step 5: Re-run targeted unit tests and verify GREEN**

```bash
node --test tests/unit/auth-rbac.test.js
```

Expected: all auth/RBAC tests PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/auth/errors.js packages/auth/index.js tests/unit/auth-rbac.test.js
git commit -m "feat: validate verified authentication claims"
```

---

### Task 2: Fail-closed authentication configuration and runtime selection

**Files:**
- Create: `services/api/src/auth-config.js`
- Create: `services/api/src/auth-runtime.js`
- Create/Test: `tests/unit/auth-config.test.js`
- Modify: `services/api/src/server.js` only after the runtime factory is GREEN.

**Interfaces:**
- Produces: `loadAuthenticationConfig(env)` returning `{ mode: 'development' }` or `{ mode: 'oidc', issuer, audience, jwksUri, algorithms }`.
- Produces: `developmentActorResolver(req)` and async `createAuthenticationResolver(env, dependencies)`.
- Consumes later: `createOidcActorResolver(config, dependencies)` from Task 3.

- [ ] **Step 1: Write RED configuration tests**

Create `tests/unit/auth-config.test.js` with explicit cases:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAuthenticationConfig } = require('../../services/api/src/auth-config');

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

test('valid oidc configuration is normalized', () => {
  assert.deepEqual(loadAuthenticationConfig(oidcEnv), {
    mode: 'oidc',
    issuer: 'https://identity.example.test',
    audience: 'dciecms-api',
    jwksUri: 'https://identity.example.test/.well-known/jwks.json',
    algorithms: ['RS256', 'ES256']
  });
});
```

- [ ] **Step 2: Run the new tests and verify RED**

```bash
node --test tests/unit/auth-config.test.js
```

Expected: FAIL because `auth-config.js` does not exist.

- [ ] **Step 3: Implement strict configuration parsing**

Create `services/api/src/auth-config.js` with a fixed asymmetric allow-set:

```js
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

function absoluteHttpUrl(value, name, production) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be an absolute URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} must use http or https`);
  if (production && parsed.protocol !== 'https:') throw new Error(`${name} must use https in production`);
  return parsed.toString().replace(/\/$/, '');
}

function loadAuthenticationConfig(env = process.env) {
  const mode = required(env, 'DCIECMS_AUTH_MODE').toLowerCase();
  const production = env.NODE_ENV === 'production';

  if (mode === 'development') {
    if (production) throw new Error('development authentication mode is forbidden in production');
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
    issuer: absoluteHttpUrl(required(env, 'DCIECMS_OIDC_ISSUER'), 'DCIECMS_OIDC_ISSUER', production),
    audience: required(env, 'DCIECMS_OIDC_AUDIENCE'),
    jwksUri: absoluteHttpUrl(required(env, 'DCIECMS_OIDC_JWKS_URI'), 'DCIECMS_OIDC_JWKS_URI', production),
    algorithms: Object.freeze([...new Set(algorithms)])
  });
}

module.exports = { loadAuthenticationConfig };
```

If stripping a trailing `/` from the issuer changes the exact issuer required by the selected IdP, remove that normalization and preserve the configured issuer byte-for-byte. The test and implementation must agree; do not silently normalize an issuer in a way that weakens exact issuer matching.

- [ ] **Step 4: Run configuration tests GREEN**

```bash
node --test tests/unit/auth-config.test.js
```

Expected: PASS.

- [ ] **Step 5: Add runtime-selection RED tests**

Extend the same test file or create a focused adjacent block:

```js
const { createAuthenticationResolver } = require('../../services/api/src/auth-runtime');

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
```

- [ ] **Step 6: Implement runtime selection**

Create `services/api/src/auth-runtime.js`:

```js
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
```

- [ ] **Step 7: Run targeted tests and commit Task 2**

```bash
node --test tests/unit/auth-config.test.js tests/unit/auth-rbac.test.js
git add services/api/src/auth-config.js services/api/src/auth-runtime.js tests/unit/auth-config.test.js
git commit -m "feat: add fail-closed authentication runtime config"
```

---

### Task 3: JOSE/JWKS bearer-token verifier

**Files:**
- Modify: `package.json`
- Create: `services/api/src/oidc-actor-resolver.js`
- Create/Test: `tests/security/production-authentication.test.js`

**Interfaces:**
- Consumes: `{ mode:'oidc', issuer, audience, jwksUri, algorithms }` from Task 2.
- Consumes: `resolveActorFromVerifiedClaims`, `AuthenticationError`, `AuthenticationUnavailableError` from Task 1.
- Produces: async `createOidcActorResolver(config, dependencies = {})` returning `async function oidcActorResolver(req)`.

- [ ] **Step 1: Add `jose` dependency**

Update root `package.json` dependencies to include the current 6.x release used by this workstream:

```json
"dependencies": {
  "jose": "^6.2.12",
  "pg": "^8.16.3"
}
```

Do not convert the CommonJS backend to ESM. Load `jose` with dynamic `import('jose')`, which keeps Node 20 CI compatible without changing package module type.

- [ ] **Step 2: Write cryptographic RED test helpers**

Create `tests/security/production-authentication.test.js` beginning with:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthenticationError, AuthenticationUnavailableError } = require('../../packages/auth');
const { createOidcActorResolver } = require('../../services/api/src/oidc-actor-resolver');

const CONFIG = Object.freeze({
  mode: 'oidc',
  issuer: 'https://identity.example.test',
  audience: 'dciecms-api',
  jwksUri: 'https://identity.example.test/.well-known/jwks.json',
  algorithms: ['RS256']
});

async function fixture() {
  const jose = await import('jose');
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const publicJwk = await jose.exportJWK(publicKey);
  Object.assign(publicJwk, { kid: 'key-1', alg: 'RS256', use: 'sig' });
  const keyResolver = jose.createLocalJWKSet({ keys: [publicJwk] });
  const resolver = await createOidcActorResolver(CONFIG, { joseModule: jose, keyResolver });

  async function sign(payload = {}, options = {}) {
    let jwt = new jose.SignJWT(payload)
      .setProtectedHeader({ alg: options.alg || 'RS256', kid: options.kid || 'key-1' })
      .setIssuer(options.issuer || CONFIG.issuer)
      .setAudience(options.audience || CONFIG.audience)
      .setIssuedAt();
    if (!options.omitSubject) jwt = jwt.setSubject(options.subject || 'u-1');
    jwt = jwt.setExpirationTime(options.expiration || '5m');
    if (options.notBefore) jwt = jwt.setNotBefore(options.notBefore);
    return jwt.sign(options.privateKey || privateKey);
  }

  return { jose, resolver, sign, privateKey };
}

const requestWith = (token, extra = {}) => ({
  headers: { authorization: `Bearer ${token}`, ...extra }
});
```

- [ ] **Step 3: Add RED happy-path and claim-mapping tests**

```js
test('valid bearer token maps only verified claims into actor', async () => {
  const { resolver, sign } = await fixture();
  const token = await sign({
    roles: ['reg'],
    court_ids: ['COURT-A'],
    explicit_grants: ['case:CASE-9']
  });
  const actor = await resolver(requestWith(token, {
    'x-dev-sub': 'spoofed',
    'x-dev-roles': 'SUPERUSER'
  }));
  assert.deepEqual(actor, {
    userId: 'u-1',
    roles: ['REG'],
    courtIds: ['COURT-A'],
    explicitGrants: ['case:CASE-9']
  });
});

test('oidc resolver requires one bearer credential and ignores dev identity', async () => {
  const { resolver } = await fixture();
  await assert.rejects(() => resolver({ headers: { 'x-dev-sub': 'reg-a' } }), AuthenticationError);
  await assert.rejects(() => resolver({ headers: { authorization: 'Basic abc' } }), AuthenticationError);
  await assert.rejects(() => resolver({ headers: { authorization: 'Bearer' } }), AuthenticationError);
});
```

- [ ] **Step 4: Add table-driven RED invalid-token tests**

Use actual signed JWTs for issuer/audience/time/subject/claim cases:

```js
test('invalid issuer, audience, expiry, nbf, subject, and claim shapes are rejected', async () => {
  const { resolver, sign } = await fixture();
  const tokens = [
    await sign({}, { issuer: 'https://evil.example.test' }),
    await sign({}, { audience: 'other-api' }),
    await sign({}, { expiration: '0s' }),
    await sign({}, { notBefore: '5m' }),
    await sign({}, { omitSubject: true }),
    await sign({ roles: 'REG' }),
    await sign({ court_ids: [123] }),
    await sign({ explicit_grants: [''] })
  ];
  for (const token of tokens) {
    await assert.rejects(() => resolver(requestWith(token)), AuthenticationError);
  }
});
```

Add a separate invalid-signature test with a second RSA private key using the same `kid`, and a disallowed algorithm test signed with `HS256` against `CONFIG.algorithms=['RS256']`. Both must reject with `AuthenticationError`.

- [ ] **Step 5: Add RED JWKS-unavailable classification test**

```js
test('JWKS timeout fails closed as authentication unavailable', async () => {
  const jose = await import('jose');
  const { privateKey } = await jose.generateKeyPair('RS256');
  const token = await new jose.SignJWT({ roles: ['REG'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-timeout' })
    .setIssuer(CONFIG.issuer)
    .setAudience(CONFIG.audience)
    .setSubject('u-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  const timeoutResolver = async () => {
    const error = new Error('fixture timeout');
    error.code = 'ERR_JWKS_TIMEOUT';
    throw error;
  };
  const resolver = await createOidcActorResolver(CONFIG, { joseModule: jose, keyResolver: timeoutResolver });
  await assert.rejects(() => resolver(requestWith(token)), AuthenticationUnavailableError);
});
```

- [ ] **Step 6: Run the security suite and verify RED**

```bash
node --test tests/security/production-authentication.test.js
```

Expected: FAIL because `oidc-actor-resolver.js` does not exist.

- [ ] **Step 7: Implement the OIDC actor resolver**

Create `services/api/src/oidc-actor-resolver.js` with these exact responsibilities:

```js
'use strict';
const {
  resolveActorFromVerifiedClaims,
  AuthenticationError,
  AuthenticationUnavailableError
} = require('../../../packages/auth');

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') throw new AuthenticationError();
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  if (!match) throw new AuthenticationError();
  return match[1];
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
      timeoutDuration: 5_000
    }
  );

  return async function oidcActorResolver(req) {
    const token = bearerToken(req);
    try {
      const { payload } = await jose.jwtVerify(token, keyResolver, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: config.algorithms
      });
      return resolveActorFromVerifiedClaims(payload);
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      if (error?.code === 'ERR_JWKS_TIMEOUT') throw new AuthenticationUnavailableError();
      if (error instanceof TypeError) throw new AuthenticationUnavailableError();
      if (isVerificationError(error, jose)) throw new AuthenticationError();
      throw error;
    }
  };
}

module.exports = { createOidcActorResolver };
```

During implementation, strengthen remote-JWKS network classification if `jose` surfaces non-timeout fetch failures as a stable distinguishable error. Do not classify `ERR_JWKS_NO_MATCHING_KEY` as infrastructure unavailable; an unknown/non-matching key for a presented token is an invalid credential and must remain 401.

- [ ] **Step 8: Add one resolver-construction/caching test**

Use a fake `joseModule` to assert `createRemoteJWKSet()` is called exactly once when the resolver is created and not once per request. Verify options are `cacheMaxAge:600000`, `cooldownDuration:30000`, `timeoutDuration:5000`.

- [ ] **Step 9: Run security + auth unit tests GREEN and commit Task 3**

```bash
node --test tests/security/production-authentication.test.js tests/unit/auth-rbac.test.js tests/unit/auth-config.test.js
git add package.json services/api/src/oidc-actor-resolver.js tests/security/production-authentication.test.js
git commit -m "feat: verify oidc bearer tokens with jwks"
```

---

### Task 4: Async HTTP authentication boundary and sanitized status mapping

**Files:**
- Modify: `services/api/src/http-app.js`
- Modify/Test: `tests/api/http-app.test.js`

**Interfaces:**
- Consumes: an actor resolver that may return an actor synchronously or a Promise of an actor.
- Consumes: `AuthenticationError`, `AuthenticationUnavailableError`.
- Produces: 401 + `WWW-Authenticate: Bearer`, 503 for authentication infrastructure unavailability, existing 403 for authorization denial, generic 500 otherwise.

- [ ] **Step 1: Add RED async-resolver and authentication-error tests**

Add tests using `createHttpApp()` with small service stubs:

```js
const { AuthenticationError, AuthenticationUnavailableError } = require('../../packages/auth');

async function withResolver(resolver, service, fn) {
  const server = http.createServer(createHttpApp(service, resolver));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('HTTP adapter awaits asynchronous actor resolver', async () => {
  await withResolver(
    async () => ({ userId:'u-1', roles:['REG'], courtIds:['COURT-A'], explicitGrants:[] }),
    { async listRegistryQueue() { return []; } },
    async base => assert.equal((await fetch(`${base}/registry/filings`)).status, 200)
  );
});

test('authentication failure returns sanitized 401 bearer challenge', async () => {
  await withResolver(
    async () => { throw new AuthenticationError('wrong audience secret detail'); },
    {},
    async base => {
      const response = await fetch(`${base}/registry/filings`);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
    }
  );
});

test('authentication infrastructure failure returns sanitized 503', async () => {
  await withResolver(
    async () => { throw new AuthenticationUnavailableError('jwks network detail'); },
    {},
    async base => {
      const response = await fetch(`${base}/registry/filings`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'authentication_unavailable' });
    }
  );
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test tests/api/http-app.test.js
```

Expected: async resolver is treated as a truthy Promise and authentication error classes fall through to 500.

- [ ] **Step 3: Update `send()` and `mapError()` without leaking details**

Modify the top of `http-app.js`:

```js
const {
  AuthenticationError,
  AuthenticationUnavailableError
} = require('../../../packages/auth');

function send(res, status, payload, headers = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    ...headers
  });
  res.end(data);
}

function mapError(error, res) {
  if (error instanceof AuthenticationError) {
    return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
  }
  if (error instanceof AuthenticationUnavailableError) {
    return send(res, 503, { error: 'authentication_unavailable' });
  }
  if (error instanceof AccessDeniedError) return send(res, 403, { error: 'forbidden' });
  if (error instanceof NotFoundError) return send(res, 404, { error: 'not_found' });
  if (error instanceof ConflictError) return send(res, 409, { error: 'conflict', message: error.message });
  if (error instanceof ValidationError) return send(res, 422, { error: 'validation_error', message: error.message });
  return send(res, 500, { error: 'internal_error' });
}
```

- [ ] **Step 4: Await the resolver**

Change only the authentication call inside the handler:

```js
const actor = await actorResolver(req);
if (!actor) {
  return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
}
```

Do not move authorization into the HTTP adapter; service/RBAC 403 behavior remains unchanged.

- [ ] **Step 5: Verify HTTP tests GREEN, including existing 403 regression**

```bash
node --test tests/api/http-app.test.js
```

Expected: all existing route tests plus new auth tests PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add services/api/src/http-app.js tests/api/http-app.test.js
git commit -m "feat: enforce async http authentication boundary"
```

---

### Task 5: Server startup uses explicit authentication mode

**Files:**
- Modify: `services/api/src/server.js`
- Modify/Test: `tests/unit/auth-config.test.js`

**Interfaces:**
- Consumes: `createAuthenticationResolver(process.env)` from Task 2.
- Produces: startup abort before `listen()` when auth configuration is invalid.

- [ ] **Step 1: Add a RED runtime-factory test for OIDC construction failure**

Add a test that supplies valid OIDC env and a factory that rejects:

```js
test('runtime does not fall back when oidc resolver construction fails', async () => {
  await assert.rejects(
    () => createAuthenticationResolver(oidcEnv, {
      createOidcActorResolver: async () => { throw new Error('verifier construction failed'); }
    }),
    /verifier construction failed/
  );
});
```

This locks in fail-closed behavior before changing `server.js`.

- [ ] **Step 2: Refactor `server.js` to construct authentication before listening**

Replace the inline development resolver with:

```js
'use strict';
const http = require('node:http');
const { createRuntimeService } = require('./runtime-service');
const { createHttpApp } = require('./http-app');
const { createAuthenticationResolver } = require('./auth-runtime');

async function startServer() {
  const service = createRuntimeService();
  const actorResolver = await createAuthenticationResolver(process.env);
  const server = http.createServer(createHttpApp(service, actorResolver));
  const port = Number(process.env.PORT || 3000);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`DCIECMS API listening on http://127.0.0.1:${port}`);
  console.log(`Persistence: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'in-memory development mode'}`);
  console.log(`Authentication mode: ${process.env.DCIECMS_AUTH_MODE}`);
  return server;
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('DCIECMS API failed to start:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { startServer };
```

Do not log the issuer, audience, JWKS URI, token, or raw claims at startup.

- [ ] **Step 3: Re-run unit/API/security tests**

```bash
node --test tests/unit/auth-config.test.js tests/api/http-app.test.js tests/security/production-authentication.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit Task 5**

```bash
git add services/api/src/server.js tests/unit/auth-config.test.js
git commit -m "feat: select authentication mode before server startup"
```

---

### Task 6: Court Workspace provider-neutral bearer-token boundary

**Files:**
- Modify: `apps/court-workspace/src/api/client.ts`
- Modify/Test: `apps/court-workspace/src/api/client.test.ts`

**Interfaces:**
- Produces: `AccessTokenProvider = () => string | undefined | Promise<string | undefined>`.
- Extends: `ApiClientConfig` with optional `accessTokenProvider`.
- Rule: when an access-token provider is configured, development identity is disabled for that request path even if the provider currently returns no token.

- [ ] **Step 1: Add RED bearer-token tests**

Append:

```ts
it('adds bearer authorization from an injected access-token provider', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
  vi.stubGlobal('fetch', fetchMock);

  await apiRequest({ method: 'GET', path: '/registry/filings' }, {
    accessTokenProvider: async () => 'signed-access-token'
  });

  const [, init] = fetchMock.mock.calls[0];
  expect(init.headers).toMatchObject({ authorization: 'Bearer signed-access-token' });
  expect(init.headers).not.toHaveProperty('x-dev-sub');
});

it('does not fall back to development identity when a token provider returns no token', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
  vi.stubGlobal('fetch', fetchMock);

  await apiRequest({ method: 'GET', path: '/registry/filings' }, {
    accessTokenProvider: async () => undefined,
    devIdentity: { enabled: true, subject: 'reg-a', roles: ['REG'], courtIds: ['COURT-A'] }
  });

  const [, init] = fetchMock.mock.calls[0];
  expect(init.headers).not.toHaveProperty('authorization');
  expect(init.headers).not.toHaveProperty('x-dev-sub');
});
```

- [ ] **Step 2: Run frontend targeted suite and verify RED**

```bash
npm --prefix apps/court-workspace test -- --run src/api/client.test.ts
```

Expected: FAIL because `accessTokenProvider` is not part of `ApiClientConfig` and headers are synchronous/dev-only.

- [ ] **Step 3: Add token-provider types and async header construction**

Modify `client.ts`:

```ts
export type AccessTokenProvider = () => string | undefined | Promise<string | undefined>;

export type ApiClientConfig = Partial<RuntimeConfig> & {
  devIdentity?: DevIdentityConfig;
  accessTokenProvider?: AccessTokenProvider;
};

type ResolvedApiClientConfig = RuntimeConfig & {
  accessTokenProvider?: AccessTokenProvider;
};

function resolveConfig(overrides: ApiClientConfig = {}): ResolvedApiClientConfig {
  const runtime = getRuntimeConfig();
  const accessTokenProvider = overrides.accessTokenProvider;
  return {
    baseUrl: overrides.baseUrl ?? runtime.baseUrl,
    accessTokenProvider,
    devIdentity: accessTokenProvider
      ? undefined
      : (overrides.devIdentity ?? runtime.devIdentity)
  };
}

async function buildHeaders(config: ResolvedApiClientConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.accessTokenProvider) {
    const token = await config.accessTokenProvider();
    if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
    return headers;
  }
  if (config.devIdentity?.enabled) {
    headers['x-dev-sub'] = config.devIdentity.subject;
    headers['x-dev-roles'] = config.devIdentity.roles.join(',');
    headers['x-dev-courts'] = config.devIdentity.courtIds.join(',');
  }
  return headers;
}
```

Then change the fetch initialization to:

```ts
headers: await buildHeaders(resolved),
```

The client must not decode the JWT or derive roles/court scope from it.

- [ ] **Step 4: Verify frontend tests and build GREEN**

```bash
npm --prefix apps/court-workspace test -- --run
npm --prefix apps/court-workspace run build
```

Expected: all frontend tests PASS and TypeScript/Vite production build succeeds.

- [ ] **Step 5: Commit Task 6**

```bash
git add apps/court-workspace/src/api/client.ts apps/court-workspace/src/api/client.test.ts
git commit -m "feat: add court workspace bearer token boundary"
```

---

### Task 7: Security regression for token non-leakage and 401/403 separation

**Files:**
- Modify/Test: `tests/security/production-authentication.test.js`
- Modify/Test: `tests/api/http-app.test.js`

**Interfaces:**
- Verifies architecture rather than adding a new production interface.

- [ ] **Step 1: Add a test proving bearer material never reaches the service actor**

Use a valid signed token containing a unique sentinel and a fake service that captures only the resolved actor:

```js
test('raw bearer token is not passed into the application actor', async () => {
  const { resolver, sign } = await fixture();
  const token = await sign({ roles:['REG'], court_ids:['COURT-A'] });
  const actor = await resolver(requestWith(token));
  assert.equal(JSON.stringify(actor).includes(token), false);
  assert.deepEqual(Object.keys(actor).sort(), ['courtIds', 'explicitGrants', 'roles', 'userId']);
});
```

- [ ] **Step 2: Add a sanitized-error regression**

Construct an invalid token string containing `TOKEN_SENTINEL_DO_NOT_LEAK`, send it through `createHttpApp()` with the OIDC resolver, and assert the serialized 401 body and response headers do not contain that sentinel or verifier exception text.

Use an assertion equivalent to:

```js
assert.equal(JSON.stringify(body).includes('TOKEN_SENTINEL_DO_NOT_LEAK'), false);
assert.equal(response.headers.get('www-authenticate'), 'Bearer');
```

- [ ] **Step 3: Reassert 403 remains authorization, not authentication**

Keep the existing ICT-admin registry test and add `WWW-Authenticate` absence:

```js
assert.equal(res.status, 403);
assert.equal(res.headers.get('www-authenticate'), null);
```

- [ ] **Step 4: Run security/API suites GREEN and commit**

```bash
npm run test:security
npm run test:api
git add tests/security/production-authentication.test.js tests/api/http-app.test.js
git commit -m "test: harden authentication boundary regressions"
```

---

### Task 8: Configuration/runbook/documentation boundary

**Files:**
- Modify: `.env.example`
- Modify: `docs/runbooks/LOCAL_DEVELOPMENT.md`
- Modify: `README.md`
- Modify: `docs/architecture/IMPLEMENTATION_STATUS.md`

**Interfaces:**
- No runtime interface changes; documents the exact configuration contract already tested in Tasks 2-5.

- [ ] **Step 1: Update `.env.example` with explicit non-secret auth configuration**

Use this shape and keep production placeholders commented:

```dotenv
# Development API
PORT=3000
DCIECMS_AUTH_MODE=development

# Production OIDC authentication example — values are placeholders only.
# Never commit live IdP credentials or production endpoint secrets.
# DCIECMS_AUTH_MODE=oidc
# DCIECMS_OIDC_ISSUER=https://identity.example.gov.pg
# DCIECMS_OIDC_AUDIENCE=dciecms-api
# DCIECMS_OIDC_JWKS_URI=https://identity.example.gov.pg/.well-known/jwks.json
# DCIECMS_OIDC_ALLOWED_ALGS=RS256
```

Retain the existing `DATABASE_URL` development example and credential warning.

- [ ] **Step 2: Update local development startup command**

Replace the old implicit dev-auth start command with:

```bash
DCIECMS_AUTH_MODE=development PORT=3000 npm start
```

State explicitly that `x-dev-*` headers work only in this mode, and that `NODE_ENV=production` rejects development auth at startup.

- [ ] **Step 3: Add an OIDC configuration contract section without live endpoints**

Document only the variable names and behavior:

```text
DCIECMS_AUTH_MODE=oidc
DCIECMS_OIDC_ISSUER=<approved issuer>
DCIECMS_OIDC_AUDIENCE=<approved DCIECMS API audience>
DCIECMS_OIDC_JWKS_URI=<approved JWKS URI>
DCIECMS_OIDC_ALLOWED_ALGS=<approved asymmetric algorithms>
```

State that actual Magisterial Services/DICT IdP registration, login flow, credentials and deployment remain separate gates.

- [ ] **Step 4: Update README and implementation status**

Record that Workstream 3 now provides a provider-neutral bearer-verification boundary in code, but do **not** claim production authentication is live. Keep these items explicitly outstanding:

```text
- real IdP tenant/client registration
- browser authorization-code + PKCE login
- production endpoint/audience/JWKS values
- production deployment/activation
- future optional hybrid DCIECMS-authoritative role/court administration
```

- [ ] **Step 5: Commit documentation**

```bash
git add .env.example docs/runbooks/LOCAL_DEVELOPMENT.md README.md docs/architecture/IMPLEMENTATION_STATUS.md
git commit -m "docs: document production authentication boundary"
```

---

### Task 9: Full verification, exact diff security review, PR and merge gate

**Files:**
- Review all changed files from Tasks 1-8.
- No new production behavior unless review finds a concrete Critical/Important defect.

**Interfaces:**
- Produces: reviewed exact branch head eligible for merge.

- [ ] **Step 1: Run complete backend regression suite**

```bash
npm test
```

Expected: all backend/unit/API/security/database tests PASS.

- [ ] **Step 2: Run explicit security suite**

```bash
npm run test:security
```

Expected: production authentication security tests PASS.

- [ ] **Step 3: Run Court Workspace regression and production build**

```bash
npm run test:frontend
npm run build:frontend
```

Expected: frontend tests PASS and Vite production build succeeds.

- [ ] **Step 4: Review the exact branch diff against the approved spec**

Review for at least these failure classes:

```text
- dev-header fallback or header spoofing in OIDC mode
- claims read before cryptographic verification
- issuer/audience/algorithm checks missing or weakened
- symmetric/none algorithm acceptance
- JWKS URL derived from token/header content
- per-request JWKS resolver recreation
- 401/403 confusion
- JWKS outage bypass
- raw token/claim/key logging or persistence
- frontend JWT decoding used as an authorization decision
- token-provider fallback to development identity
- production mode accepting DCIECMS_AUTH_MODE=development
```

Correct every Critical or Important finding with a RED test first, then the minimum fix, then re-run the affected suite.

- [ ] **Step 5: Create/update the pull request and wait for fresh exact-head CI**

The PR body must state:

```text
Implements the approved provider-neutral production authentication boundary.
No production IdP credentials, live authentication activation, production deployment, DNS change, or database migration are included.
```

CI must run on the exact final PR head and include backend tests, Court Workspace tests, and production frontend build.

- [ ] **Step 6: Merge only after exact-head CI is fully GREEN**

Use the repository's established merge method. Record the resulting merge SHA.

- [ ] **Step 7: Verify post-merge `main` CI on the exact merge SHA**

Do not call Workstream 3 complete until the `main` push workflow for that exact SHA finishes successfully.

---

## Self-Review Checklist

Before execution begins, verify this plan against the approved spec:

- [ ] Every accepted design section maps to at least one implementation task.
- [ ] `sub`, `roles`, `court_ids`, `explicit_grants` are trusted only after verification.
- [ ] Missing/malformed/invalid/expired/not-yet-valid/wrong-issuer/wrong-audience/disallowed-alg tokens are covered by 401 tests.
- [ ] JWKS timeout/unavailability is covered by a fail-closed 503 path.
- [ ] Existing RBAC/court-scope denial remains 403.
- [ ] OIDC mode never reads `x-dev-*` identity.
- [ ] Production startup cannot use development auth or incomplete OIDC config.
- [ ] JWKS resolver is constructed once and has cache/cooldown/timeout configuration.
- [ ] Frontend bearer injection exists without browser login or JWT-derived authorization.
- [ ] No bearer token or raw claim persistence/logging is introduced.
- [ ] No live IdP configuration, credentials, production deployment, or DB migration is included.
- [ ] Full backend/frontend/build/CI/security-review gates are explicit.
- [ ] Plan contains no `TODO`, `TBD`, `implement later`, or unspecified "add tests" placeholders.
