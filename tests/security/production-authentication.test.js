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

test('raw bearer token is not passed into the application actor', async () => {
  const { resolver, sign } = await fixture();
  const token = await sign({ roles:['REG'], court_ids:['COURT-A'] });
  const actor = await resolver(requestWith(token));
  assert.equal(JSON.stringify(actor).includes(token), false);
  assert.deepEqual(Object.keys(actor).sort(), ['courtIds', 'explicitGrants', 'roles', 'userId']);
});
