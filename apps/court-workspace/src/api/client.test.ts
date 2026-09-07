import { afterEach, describe, expect, it, vi } from 'vitest';
import * as apiClient from './client';
import { ApiError, apiRequest, returnFiling } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Court Workspace API client', () => {
  it('uses the configured relative base URL and JSON request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'RETURNED' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await returnFiling('filing-1', 'Missing affidavit', { baseUrl: '/api' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/filings/filing-1/return');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(init.headers).not.toHaveProperty('x-dev-sub');
    expect(JSON.parse(init.body)).toEqual({ reason: 'Missing affidavit' });
  });

  it.each([
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'validation'],
    [500, 'server']
  ] as const)('maps HTTP %s to %s', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Server message' }), {
      status,
      headers: { 'content-type': 'application/json' }
    })));

    await expect(apiRequest({ method: 'GET', path: '/registry/filings' })).rejects.toMatchObject({
      name: 'ApiError',
      status,
      kind,
      message: 'Server message'
    });
  });

  it('maps network failures without exposing an internal exception message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket details')));

    try {
      await apiRequest({ method: 'GET', path: '/registry/filings' });
      throw new Error('expected request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 0, kind: 'network', message: 'Unable to reach the DCIECMS service.' });
    }
  });

  it('adds development identity headers only when explicitly enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest({ method: 'GET', path: '/registry/filings' }, {
      devIdentity: { enabled: true, subject: 'reg-a', roles: ['REG'], courtIds: ['court-a'] }
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({
      'x-dev-sub': 'reg-a',
      'x-dev-roles': 'REG',
      'x-dev-courts': 'court-a'
    });
  });

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

  it('requests a provider-neutral payment session without browser-controlled settlement evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      checkoutUrl: 'https://checkout.example.invalid/session-a',
      expiresAt: '2026-09-07T03:00:00.000Z',
      providerCode: 'must-not-cross-client-boundary',
      providerPaymentReference: 'must-not-cross-client-boundary',
      webhookSignature: 'must-not-cross-client-boundary'
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    const createSession = (apiClient as unknown as {
      createPaymentSession?: (paymentId: string, config?: { baseUrl?: string }) => Promise<Record<string, unknown>>
    }).createPaymentSession;
    expect(createSession).toBeTypeOf('function');
    if (!createSession) return;

    const result = await createSession('payment-1', { baseUrl: '/api' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/payments/payment-1/sessions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({});
    expect(result).toEqual({
      checkoutUrl: 'https://checkout.example.invalid/session-a',
      expiresAt: '2026-09-07T03:00:00.000Z'
    });
    expect(result).not.toHaveProperty('providerCode');
    expect(result).not.toHaveProperty('providerPaymentReference');
    expect(result).not.toHaveProperty('webhookSignature');
  });

  it('does not export the legacy browser provider-confirmation function', () => {
    expect(apiClient).not.toHaveProperty('confirmPayment');
  });
});
