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
- OIDC issuer and JWKS URLs use HTTPS; controlled tests inject local key resolvers instead of weakening that runtime rule.
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
- `services/api/src/oidc-actor-resolver.js` — bearer extraction, JWKS transport, JWT verification, safe error classification, verified-claim actor mapping.
- `services/api/src/auth-runtime.js` — selects development vs OIDC resolver and enforces the production boundary.
- `tests/security/production-authentication.test.js` — cryptographic token/JWKS security regression suite.
- `tests/unit/auth-config.test.js` — fail-closed configuration and mode-selection tests.

### Modify

- `packages/auth/index.js` — add strict `resolveActorFromVerifiedClaims()` while preserving existing `resolveActorFromClaims()` behavior.
- `services/api/src/http-app.js` — await async actor resolvers and map authentication-specific failures.
- `services/api/src/server.js` — construct the configured authentication resolver before listening.
- `tests/unit/auth-rbac.test.js` — verified-claim shape tests.
- `tests/api/http-app.test.js` — 401/403/503/500 and async-resolver integration tests.
- `package.json` — add `jose` 6.x backend dependency.
- `apps/court-workspace/src/api/client.ts` — injected bearer-token provider and no dev fallback.
- `apps/court-workspace/src/api/client.test.ts` — bearer header and no-fallback tests.
- `.env.example` — explicit development/OIDC authentication settings without real credentials.
- `docs/runbooks/LOCAL_DEVELOPMENT.md` — explicit development-mode startup and dependency instructions.
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

Append:

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

Modify `packages/auth/index.js`:

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

**Interfaces:**
- Produces: `loadAuthenticationConfig(env)` returning `{ mode: 'development' }` or `{ mode: 'oidc', issuer, audience, jwksUri, algorithms }`.
- Produces: `developmentActorResolver(req)` and async `createAuthenticationResolver(env, dependencies)`.
- Consumes later: `createOidcActorResolver(config, dependencies)` from Task 3.

- [ ] **Step 1: Write RED configuration tests**

Create `tests/unit/auth-config.test.js`:

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
```

- [ ] **Step 2: Run the new tests and verify RED**

```bash
node --test tests/unit/auth-config.test.js
```

Expected: FAIL because `auth-config.js` does not exist.

- [ ] **Step 3: Implement strict configuration parsing**

Create `services/api/src/auth-config.js`:

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
```

- [ ] **Step 4: Run configuration tests GREEN**

```bash
node --test tests/unit/auth-config.test.js
```

Expected: PASS.

- [ ] **Step 5: Add runtime-selection RED tests to `tests/unit/auth-config.test.js`**

Append:

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

test('runtime does not fall back when oidc resolver construction fails', async () => {
  await assert.rejects(
    () => createAuthenticationResolver(oidcEnv, {
      createOidcActorResolver: async () => { throw new Error('verifier construction failed'); }
    }),
    /verifier construction failed/
  );
});
```

- [ ] **Step 6: Verify runtime tests are RED**

```bash
node --test tests/unit/auth-config.test.js
```

Expected: FAIL because `auth-runtime.js` does not exist.

- [ ] **Step 7: Implement runtime selection**

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

- [ ] **Step 8: Run Task 2 tests GREEN and commit**

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
- Produces: `createJwksFetch(fetchImpl)` and async `createOidcActorResolver(config, dependencies = {})` returning `async function oidcActorResolver(req)`.

- [ ] **Step 1: Add `jose` dependency**

Update root `package.json`:

```json
"dependencies": {
  "jose": "^6.2.12",
  "pg": "^8.16.3"
}
```

Keep the backend CommonJS. Load `jose` with dynamic `import('jose')` so Node 20 CI does not depend on CommonJS `require(esm)` support.

- [ ] **Step 2: Create RED cryptographic test fixture**

Create `tests/security/production-authentication.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AuthenticationError,
  AuthenticationUnavailableError
} = require('../../packages/auth');
const {
  createJwksFetch,
  createOidcActorResolver
} = require('../../services/api/src/oidc-actor-resolver');

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

  return { jose, resolver, sign };
}

const requestWith = (token, extra = {}) => ({
  headers: { authorization: `Bearer ${token}`, ...extra }
});
```

- [ ] **Step 3: Add RED happy-path and dev-header isolation tests**

Append:

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

test('oidc resolver requires bearer credentials and never accepts dev identity', async () => {
  const { resolver } = await fixture();
  await assert.rejects(() => resolver({ headers: { 'x-dev-sub': 'reg-a' } }), AuthenticationError);
  await assert.rejects(() => resolver({ headers: { authorization: 'Basic abc' } }), AuthenticationError);
  await assert.rejects(() => resolver({ headers: { authorization: 'Bearer' } }), AuthenticationError);
});
```

- [ ] **Step 4: Add RED invalid issuer/audience/time/claim tests**

Append:

```js
test('issuer audience time subject and claim-shape failures are rejected', async () => {
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

- [ ] **Step 5: Add exact RED signature/algorithm/key-selection tests**

Append:

```js
test('invalid signature is rejected', async () => {
  const { jose, resolver, sign } = await fixture();
  const { privateKey: otherPrivateKey } = await jose.generateKeyPair('RS256');
  const token = await sign({}, { privateKey: otherPrivateKey });
  await assert.rejects(() => resolver(requestWith(token)), AuthenticationError);
});

test('disallowed signing algorithm is rejected before authorization claims are used', async () => {
  const { jose, resolver } = await fixture();
  const secret = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
  const token = await new jose.SignJWT({ roles: ['REG'], court_ids: ['COURT-A'] })
    .setProtectedHeader({ alg: 'HS256', kid: 'symmetric-key' })
    .setIssuer(CONFIG.issuer)
    .setAudience(CONFIG.audience)
    .setSubject('u-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
  await assert.rejects(() => resolver(requestWith(token)), AuthenticationError);
});

test('unknown kid is an invalid credential rather than an infrastructure outage', async () => {
  const { resolver, sign } = await fixture();
  const token = await sign({}, { kid: 'unknown-key' });
  await assert.rejects(() => resolver(requestWith(token)), AuthenticationError);
});
```

- [ ] **Step 6: Add RED JWKS infrastructure tests**

Append:

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

test('JWKS transport converts network and non-2xx failures to authentication unavailable', async () => {
  const options = {
    headers: new Headers(),
    method: 'GET',
    redirect: 'manual',
    signal: new AbortController().signal
  };
  const networkFetch = createJwksFetch(async () => { throw new Error('ECONNRESET internal detail'); });
  await assert.rejects(() => networkFetch(CONFIG.jwksUri, options), AuthenticationUnavailableError);

  const httpFetch = createJwksFetch(async () => new Response('down', { status: 503 }));
  await assert.rejects(() => httpFetch(CONFIG.jwksUri, options), AuthenticationUnavailableError);
});
```

- [ ] **Step 7: Add RED one-resolver-per-process cache configuration test**

Append:

```js
test('remote JWKS resolver is constructed once with bounded cache settings', async () => {
  const customFetch = Symbol('customFetch');
  let createCalls = 0;
  let seenOptions;
  class FakeJoseError extends Error {}
  const joseModule = {
    customFetch,
    errors: { JOSEError: FakeJoseError },
    createRemoteJWKSet(_url, options) {
      createCalls += 1;
      seenOptions = options;
      return Symbol('remote-jwks');
    },
    async jwtVerify() {
      return { payload: { sub:'u-1', roles:['REG'], court_ids:['COURT-A'], explicit_grants:[] } };
    }
  };

  const resolver = await createOidcActorResolver(CONFIG, {
    joseModule,
    fetchImpl: async () => new Response('{"keys":[]}', { status: 200 })
  });
  await resolver(requestWith('token-one'));
  await resolver(requestWith('token-two'));

  assert.equal(createCalls, 1);
  assert.equal(seenOptions.cacheMaxAge, 600_000);
  assert.equal(seenOptions.cooldownDuration, 30_000);
  assert.equal(seenOptions.timeoutDuration, 5_000);
  assert.equal(typeof seenOptions[customFetch], 'function');
});
```

- [ ] **Step 8: Run security tests and verify RED**

```bash
node --test tests/security/production-authentication.test.js
```

Expected: FAIL because `oidc-actor-resolver.js` does not exist.

- [ ] **Step 9: Implement the OIDC/JWKS actor resolver**

Create `services/api/src/oidc-actor-resolver.js`:

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
        algorithms: config.algorithms
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
```

`ERR_JWKS_NO_MATCHING_KEY` remains in the invalid-credential path and therefore becomes 401, not 503. The configured JWKS URL is the only remote key source; no token/header value can change it.

- [ ] **Step 10: Run security + auth unit tests GREEN and commit Task 3**

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
- Produces: bearer-auth failures as 401 + `WWW-Authenticate: Bearer`, JWKS infrastructure unavailability as 503, existing authorization denial as 403, and unexpected errors as generic 500.

- [ ] **Step 1: Add RED HTTP authentication test helper**

Append near the existing helpers:

```js
const { AuthenticationError, AuthenticationUnavailableError } = require('../../packages/auth');

async function withResolver(resolver, service, fn) {
  const server = http.createServer(createHttpApp(service, resolver));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
```

- [ ] **Step 2: Add exact RED HTTP authentication tests**

Append:

```js
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
      assert.equal(response.headers.get('www-authenticate'), null);
      assert.deepEqual(await response.json(), { error: 'authentication_unavailable' });
    }
  );
});

test('unexpected authentication boundary error returns sanitized 500', async () => {
  await withResolver(
    async () => { throw new Error('INTERNAL_AUTH_DETAIL_DO_NOT_LEAK'); },
    {},
    async base => {
      const response = await fetch(`${base}/registry/filings`);
      const text = await response.text();
      assert.equal(response.status, 500);
      assert.equal(response.headers.get('www-authenticate'), null);
      assert.equal(text.includes('INTERNAL_AUTH_DETAIL_DO_NOT_LEAK'), false);
      assert.deepEqual(JSON.parse(text), { error: 'internal_error' });
    }
  );
});
```

- [ ] **Step 3: Verify RED**

```bash
node --test tests/api/http-app.test.js
```

Expected: authentication error classes currently fall through to 500 and the resolver is not awaited.

- [ ] **Step 4: Update `send()` and `mapError()`**

Modify the top of `services/api/src/http-app.js`:

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

- [ ] **Step 5: Await the resolver while preserving development-mode missing-actor behavior**

Change only:

```js
const actor = await actorResolver(req);
if (!actor) return send(res, 401, { error: 'unauthorized' });
```

OIDC missing/malformed bearer credentials throw `AuthenticationError` and therefore receive the Bearer challenge. A development resolver returning `null` keeps the existing generic 401 without pretending a bearer credential was requested.

- [ ] **Step 6: Verify HTTP tests GREEN and commit**

```bash
node --test tests/api/http-app.test.js
git add services/api/src/http-app.js tests/api/http-app.test.js
git commit -m "feat: enforce async http authentication boundary"
```

---

### Task 5: Server startup uses explicit authentication mode

**Files:**
- Modify: `services/api/src/server.js`
- Test: `tests/unit/auth-config.test.js` runtime-construction tests from Task 2.

**Interfaces:**
- Consumes: `createAuthenticationResolver(process.env)` from Task 2.
- Produces: startup abort before `listen()` when auth configuration or resolver construction is invalid.

- [ ] **Step 1: Refactor `server.js` to construct authentication before listening**

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

Do not log issuer, audience, JWKS URI, token, key data, or raw claims.

- [ ] **Step 2: Run authentication/runtime/API/security suites**

```bash
node --test tests/unit/auth-config.test.js tests/api/http-app.test.js tests/security/production-authentication.test.js
```

Expected: PASS. The runtime-construction rejection test proves there is no fallback if OIDC resolver construction fails.

- [ ] **Step 3: Commit Task 5**

```bash
git add services/api/src/server.js
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

Expected: FAIL because `accessTokenProvider` is not part of `ApiClientConfig`.

- [ ] **Step 3: Add token-provider types and async header construction**

Modify `apps/court-workspace/src/api/client.ts`:

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

Change fetch initialization from `headers: buildHeaders(...)` to:

```ts
headers: await buildHeaders(resolved),
```

The frontend must not decode JWT claims or make RBAC/court-scope authorization decisions.

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
- Adds no runtime API; verifies the trust boundary cannot leak bearer material or collapse 403 into 401.

- [ ] **Step 1: Add raw-token non-propagation test**

Append to `tests/security/production-authentication.test.js`:

```js
test('raw bearer token is not passed into the application actor', async () => {
  const { resolver, sign } = await fixture();
  const token = await sign({ roles:['REG'], court_ids:['COURT-A'] });
  const actor = await resolver(requestWith(token));
  assert.equal(JSON.stringify(actor).includes(token), false);
  assert.deepEqual(Object.keys(actor).sort(), ['courtIds', 'explicitGrants', 'roles', 'userId']);
});
```

- [ ] **Step 2: Add exact sanitized-error regression**

Append to `tests/api/http-app.test.js`:

```js
test('authentication error response never echoes bearer material or verifier detail', async () => {
  const sentinel = 'TOKEN_SENTINEL_DO_NOT_LEAK';
  await withResolver(
    async req => {
      throw new AuthenticationError(`invalid ${req.headers.authorization} verifier-internal-detail`);
    },
    {},
    async base => {
      const response = await fetch(`${base}/registry/filings`, {
        headers: { authorization: `Bearer ${sentinel}` }
      });
      const text = await response.text();
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      assert.equal(text.includes(sentinel), false);
      assert.equal(text.includes('verifier-internal-detail'), false);
    }
  );
});
```

- [ ] **Step 3: Tighten existing 403 regression**

In the existing ICT-admin registry test add:

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
- Documents the configuration contract already enforced by Tasks 2-5.

- [ ] **Step 1: Update `.env.example`**

Retain the database example and add:

```dotenv
# Development API
PORT=3000
DCIECMS_AUTH_MODE=development

# Production OIDC authentication example — values are placeholders only.
# Never commit live IdP credentials.
# DCIECMS_AUTH_MODE=oidc
# DCIECMS_OIDC_ISSUER=https://identity.example.gov.pg
# DCIECMS_OIDC_AUDIENCE=dciecms-api
# DCIECMS_OIDC_JWKS_URI=https://identity.example.gov.pg/.well-known/jwks.json
# DCIECMS_OIDC_ALLOWED_ALGS=RS256
```

- [ ] **Step 2: Correct local-development preconditions and startup instructions**

Replace the stale dependency statement with:

```text
Run npm install at the repository root before starting the API. The backend uses pg for PostgreSQL access and jose for production JWT/JWKS verification.
```

Replace the old start command with:

```bash
DCIECMS_AUTH_MODE=development PORT=3000 npm start
```

Add:

```text
The x-dev-* identity headers are accepted only when DCIECMS_AUTH_MODE=development.
NODE_ENV=production rejects development authentication at startup.
OIDC mode never reads x-dev-* identity headers.
```

- [ ] **Step 3: Add the provider-neutral OIDC configuration contract**

Document:

```text
DCIECMS_AUTH_MODE=oidc
DCIECMS_OIDC_ISSUER=<approved HTTPS issuer>
DCIECMS_OIDC_AUDIENCE=<approved DCIECMS API audience>
DCIECMS_OIDC_JWKS_URI=<approved HTTPS JWKS URI>
DCIECMS_OIDC_ALLOWED_ALGS=<approved asymmetric algorithms>
```

State that actual Magisterial Services/DICT IdP registration, browser login flow, credentials and deployment remain separate production gates.

- [ ] **Step 4: Update README and implementation status with exact remaining boundaries**

Record the code boundary as implemented only after Tasks 1-7 are green, while keeping these items outstanding:

```text
- real IdP tenant/client registration
- browser authorization-code + PKCE login
- production endpoint/audience/JWKS values
- production deployment/activation
- future optional hybrid DCIECMS-authoritative role/court administration
```

Do not describe production authentication as live.

- [ ] **Step 5: Commit documentation**

```bash
git add .env.example docs/runbooks/LOCAL_DEVELOPMENT.md README.md docs/architecture/IMPLEMENTATION_STATUS.md
git commit -m "docs: document production authentication boundary"
```

---

### Task 9: Full verification, exact diff security review, PR and merge gate

**Files:**
- Review all changed files from Tasks 1-8.
- Add code only when a concrete review defect first has a failing regression test.

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

Check every changed line for:

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

For each Critical or Important defect: add a failing regression test, confirm RED, apply the smallest fix, rerun the affected suite, then rerun the full verification gate.

- [ ] **Step 5: Create/update the pull request and wait for fresh exact-head CI**

Use this scope statement in the PR body:

```text
Implements the approved provider-neutral production authentication boundary.
No production IdP credentials, live authentication activation, production deployment, DNS change, or database migration are included.
```

The exact final PR head must pass GitHub Actions backend tests, Court Workspace tests, and production frontend build.

- [ ] **Step 6: Merge only after exact-head CI is fully GREEN**

Use the repository's established merge method and record the merge SHA.

- [ ] **Step 7: Verify post-merge `main` CI on the exact merge SHA**

Do not call Workstream 3 complete until the `main` push workflow for that exact SHA finishes successfully.

---

## Self-Review Checklist

- [ ] Every accepted design section maps to at least one implementation task.
- [ ] `sub`, `roles`, `court_ids`, `explicit_grants` are trusted only after verification.
- [ ] Missing/malformed/invalid-signature/wrong-issuer/wrong-audience/expired/not-yet-valid/disallowed-alg/unknown-key tokens are covered by invalid-credential tests.
- [ ] JWKS timeout, network failure, and non-2xx transport failure are fail-closed.
- [ ] Existing RBAC/court-scope denial remains 403.
- [ ] OIDC mode never reads `x-dev-*` identity.
- [ ] Production startup cannot use development auth or incomplete OIDC config.
- [ ] JWKS resolver is constructed once and has cache/cooldown/timeout configuration.
- [ ] Frontend bearer injection exists without browser login or JWT-derived authorization.
- [ ] No bearer token or raw claim persistence/logging is introduced.
- [ ] Unexpected authentication-boundary failures are sanitized 500 responses.
- [ ] No live IdP configuration, credentials, production deployment, or DB migration is included.
- [ ] Full backend/frontend/build/CI/security-review gates are explicit.
- [ ] The plan contains no unresolved implementation placeholders.
