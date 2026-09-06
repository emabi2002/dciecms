# DCIECMS Production Authentication Boundary Design

## Status

Approved architectural design for the provider-neutral DCIECMS production authentication boundary.

This design replaces development-only request identity headers with a standards-based OIDC/JWT bearer-token verification boundary for production use while preserving the existing DCIECMS actor, RBAC, court-scope and explicit-grant authorization model.

No production IdP registration, credential provisioning, production deployment, DNS change or live environment activation is part of this workstream.

## Objective

Introduce a secure production authentication boundary that:

1. accepts identity only from a verified bearer access token when production authentication is enabled;
2. validates JWT signature, issuer, audience, temporal validity and an explicit signing-algorithm allow-list;
3. verifies signing keys through an approved JWKS endpoint with cache/key-rotation support;
4. maps only verified claims into the existing DCIECMS actor structure;
5. preserves existing RBAC, court-scope and explicit-grant authorization controls;
6. fails closed when authentication configuration or token verification is unsafe or unavailable;
7. keeps development identity headers strictly separated from production authentication;
8. provides a provider-neutral frontend access-token injection boundary without implementing a real IdP login flow yet.

## Current State

The current authentication package only normalizes supplied claims into the DCIECMS actor model. The executable development server constructs those claims from `x-dev-*` request headers and the Court Workspace can emit matching development headers when explicitly configured.

Those development headers are not production identity evidence and must never be trusted in production.

## Selected Approach

### Chosen: OIDC/JWT bearer verification using a mature JOSE library and JWKS

The production API will use a standards-based JWT verification library rather than implementing cryptographic verification directly.

The verifier will:

- extract a bearer token from the HTTP `Authorization` header;
- verify the token signature against the configured JWKS endpoint;
- require the configured trusted issuer;
- require the configured API audience;
- enforce `exp` and `nbf` validation;
- enforce an explicit allow-list of asymmetric signing algorithms;
- return verified claims only after all verification succeeds;
- reuse JWKS cache/key-rotation state rather than rebuilding verification state for each request.

### Rejected alternatives

#### Trusted reverse-proxy identity headers

This would be simpler but would move too much authentication trust outside the DCIECMS application and create a dangerous header-spoofing dependency unless the full gateway/network trust boundary were already finalized.

#### Hand-written JWT/JWK verification using Node crypto

This would avoid a package dependency but would create unnecessary cryptographic implementation and maintenance risk. DCIECMS should use a mature, reviewed JOSE implementation.

## Trust Boundary

Production request flow:

```text
HTTP request
  -> Authorization: Bearer <access-token>
  -> production authentication resolver
  -> JWT/OIDC verifier
  -> verified claims
  -> resolveActorFromClaims()
  -> existing RBAC / court-scope / explicit-grant authorization
  -> application service
```

The authentication boundary proves who the caller is and which signed authorization claims were asserted by the trusted identity system. It does not bypass application authorization.

A successfully authenticated actor with no recognized DCIECMS role, insufficient permission or the wrong court scope must continue to receive authorization denial from the existing RBAC layer.

## Authentication Modes

The API runtime must have an explicit authentication mode.

### `development`

- intended only for controlled local/non-production development;
- may resolve identity from the existing `x-dev-*` request headers;
- must remain visibly documented as development-only scaffolding.

### `oidc`

- production bearer-token verification only;
- all `x-dev-*` headers are ignored even if supplied by a client;
- no fallback to development identity is permitted;
- incomplete or invalid OIDC configuration causes startup failure.

Unknown authentication modes must be rejected at startup.

A production runtime must never silently select development authentication because OIDC configuration is absent.

## Production Configuration Contract

The provider-neutral OIDC verifier will be configured through explicit runtime settings equivalent to:

```text
DCIECMS_AUTH_MODE=oidc
DCIECMS_OIDC_ISSUER=<trusted issuer>
DCIECMS_OIDC_AUDIENCE=<required DCIECMS API audience>
DCIECMS_OIDC_JWKS_URI=<approved JWKS endpoint>
DCIECMS_OIDC_ALLOWED_ALGS=RS256,ES256
```

The implementation must require non-empty, syntactically valid OIDC values in `oidc` mode.

`DCIECMS_OIDC_ALLOWED_ALGS` is an explicit allow-list. The application must not accept an algorithm merely because it appears in a token header or JWKS response.

No actual Magisterial Services, DICT or other production IdP URLs, secrets or credentials will be committed to the repository in this workstream.

## Verified Claim Contract

After cryptographic and protocol verification succeeds, DCIECMS will accept the following verified claims for actor construction:

- `sub` -> `actor.userId`
- `roles` -> `actor.roles`
- `court_ids` -> `actor.courtIds`
- `explicit_grants` -> `actor.explicitGrants`

The existing normalization behavior remains authoritative for converting these verified claims into the actor structure.

### Required claim semantics

- `sub` is required and must be a non-empty scalar string value.
- `roles`, when present, must be an array of scalar string values.
- `court_ids`, when present, must be an array of scalar string values.
- `explicit_grants`, when present, must be an array of scalar string values.
- malformed authorization-claim types cause authentication failure rather than coercion.
- role values continue to normalize to uppercase through the existing actor mapper.
- duplicate roles, courts and grants continue to be deduplicated.

No role, court assignment or explicit grant may be inferred from email address, username, browser state, unverified HTTP headers or other unsigned metadata.

## Bearer-Token Verification Contract

A production bearer token is accepted only if all required checks succeed.

The verifier must enforce:

1. a syntactically valid `Authorization: Bearer <token>` request header;
2. a valid JWT signature using a key resolved from the configured JWKS endpoint;
3. exact trusted issuer validation;
4. required audience validation;
5. token expiry validation;
6. not-before validation;
7. explicit signing-algorithm allow-list validation;
8. required `sub` validation;
9. valid authorization-claim shapes.

The API must not inspect authorization claims before token verification and then use them to authorize access.

## JWKS and Key Rotation

The authentication resolver is constructed once at process startup and holds the verifier/JWKS state for reuse across requests.

The selected JOSE/JWKS implementation must support:

- cached signing keys;
- refresh when an unknown `kid` requires key discovery;
- safe key rotation;
- bounded network behavior provided by the library/runtime;
- no use of token-provided arbitrary JWKS URLs.

Only the configured JWKS endpoint is trusted for key resolution.

## HTTP Integration

`createHttpApp()` currently receives an actor resolver synchronously. This boundary must be upgraded so the resolver can be asynchronous:

```text
actor = await actorResolver(req)
```

This is required because JWKS discovery or refresh may require asynchronous I/O.

The HTTP application remains responsible for converting authentication outcomes into sanitized protocol responses.

## Authentication Error Model

The production authentication adapter must distinguish at least these categories:

### Unauthenticated / invalid credentials -> HTTP 401

Examples:

- missing bearer token;
- malformed bearer header;
- invalid JWT format;
- invalid signature;
- untrusted issuer;
- wrong audience;
- expired token;
- token not yet valid;
- disallowed algorithm;
- missing subject;
- malformed authorization-claim types.

Where appropriate, a 401 response should include a standards-compatible:

```text
WWW-Authenticate: Bearer
```

The response body must remain generic and must not disclose cryptographic or claim-validation details.

### Authenticated but unauthorized -> HTTP 403

A valid token whose actor lacks a required permission, court scope or other authorization constraint remains an authorization failure handled by the existing RBAC layer.

Authentication must not collapse these cases into 401.

### Verification infrastructure unavailable -> HTTP 503

If a token cannot be safely verified because the configured JWKS verification infrastructure is temporarily unavailable, the request must fail closed with 503 rather than accepting an unverified token.

A verification-infrastructure failure must be distinguished from a conclusively invalid token when the underlying library exposes that distinction safely.

### Unexpected internal authentication error -> sanitized HTTP 500

Unexpected failures must not echo token contents, signing keys, raw claims or stack traces to the client.

## Sensitive-Data Handling

Bearer tokens and raw sensitive claims must never be persisted into:

- application audit event metadata;
- durable outbox payloads or headers;
- repository/domain records;
- API error bodies;
- routine application logs.

If security telemetry later records authentication-failure categories, it must redact credentials and avoid logging raw tokens.

## Frontend / Court Workspace Boundary

This workstream does not implement the actual IdP login page, authorization-code flow, PKCE redirect handling or token refresh lifecycle.

Instead, the Court Workspace API client will gain a provider-neutral access-token boundary.

The intended client contract is an injected token source, for example an asynchronous callback that can return the current bearer access token when a request is made.

When a bearer token is available, the API client sends:

```text
Authorization: Bearer <token>
```

The frontend must not invent, persist or decode authorization claims for access-control decisions.

The browser is not an authorization boundary.

### Development identity separation

The existing development identity configuration remains available only when explicitly enabled for development.

The client must never emit both bearer identity and `x-dev-*` identity for the same request.

The absence of a bearer token must not cause an automatic fallback to development identity unless the frontend has been explicitly configured for development identity mode.

Production-oriented frontend configuration must not silently enable development identity.

## Expected Code Boundaries

The implementation is expected to keep responsibilities isolated:

### `packages/auth`

- preserve `resolveActorFromClaims()` as the normalized actor mapper;
- add production authentication errors/config validation and/or verifier construction in focused modules rather than putting HTTP concerns into RBAC code.

### `services/api/src`

- add a production OIDC actor resolver/adaptor;
- upgrade `createHttpApp()` to await an actor resolver;
- map authentication-specific errors to 401/503/500 without leaking verification details;
- select authentication mode at startup in `server.js` or a focused runtime-auth factory.

### Court Workspace

- extend API client configuration with a provider-neutral access-token provider;
- emit `Authorization: Bearer` when a token is supplied;
- preserve explicit development identity for local development only;
- do not implement a real IdP login flow in this workstream.

### Dependencies

- add one mature JOSE/JWT verification dependency suitable for Node.js 20+;
- do not add a full identity-provider SDK unless a later provider-specific integration requires it.

## Startup Failure Rules

OIDC mode must fail during startup/configuration when any mandatory value is absent or malformed, including:

- issuer;
- audience;
- JWKS URI;
- allowed signing algorithms.

The runtime must not start an OIDC API in a partially configured state that later falls back to development identity.

## Testing Strategy

Implementation will follow RED -> GREEN TDD gates.

Tests will use generated local signing keys and controlled JWKS fixtures. CI will not require a real government identity provider, internet-accessible production JWKS endpoint or production credentials.

### Required verification matrix

The final workstream must verify:

1. valid signed bearer token with correct issuer/audience authenticates successfully;
2. verified `sub`, `roles`, `court_ids` and `explicit_grants` map correctly into the actor model;
3. missing token returns 401;
4. malformed authorization header returns 401;
5. invalid signature returns 401;
6. untrusted issuer returns 401;
7. wrong audience returns 401;
8. expired token returns 401;
9. future `nbf` returns 401;
10. disallowed algorithm returns 401;
11. missing `sub` returns 401;
12. malformed role/court/grant claim types return 401;
13. an authenticated actor without a required permission still receives 403;
14. an authenticated actor outside court scope still receives 403;
15. `x-dev-*` headers are ignored in OIDC mode;
16. incomplete OIDC startup configuration fails closed;
17. JWKS verification infrastructure failure produces 503 rather than bypass;
18. API errors do not expose bearer tokens, raw claims, keys or verification internals;
19. audit and outbox records do not capture bearer-token material;
20. Court Workspace sends bearer auth through the injected token boundary;
21. Court Workspace does not silently fall back to development identity when no bearer token exists;
22. all pre-existing RBAC, API, backend and frontend regressions remain green.

## Release Verification Gate

Before merge, the branch must pass:

```text
backend tests
-> security tests
-> Court Workspace tests
-> production Court Workspace build
-> exact PR diff security review
-> fresh exact-head GitHub Actions CI
```

After merge, `main` CI must be checked on the exact merge commit before the workstream is called complete.

## Explicit Non-Goals

This workstream does not include:

- real production IdP tenant/client registration;
- production client IDs, secrets, certificates or service credentials;
- browser authorization-code/PKCE login implementation;
- refresh-token lifecycle implementation;
- logout/session federation;
- identity provisioning or user lifecycle synchronization;
- DCIECMS-owned role/court administration database tables;
- production deployment;
- production DNS, gateway, WAF or reverse-proxy changes;
- live authentication activation;
- live Supabase/database migration.

## Future Evolution

The chosen design deliberately allows a future hybrid authorization model in which the IdP proves identity while DCIECMS becomes authoritative for roles, court assignments and exceptional grants.

That future model is outside this workstream and must not be introduced implicitly while implementing the current verified-token authorization-claim design.

## Acceptance Boundary

The workstream is complete only when DCIECMS has a tested, provider-neutral production bearer-token verification boundary in code and the current development identity mechanism is impossible to use as production identity evidence when OIDC mode is active.

Actual production authentication remains a separate deployment/configuration gate requiring the approved IdP endpoint, audience, JWKS configuration and operational credentials/environment approval.