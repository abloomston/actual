import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SecretName, secretsService } from '#services/secrets-service';
import { assertUrlAllowed } from '#util/ssrf';

import { handlers as app } from './app-simplefin';

vi.mock('#util/ssrf', () => ({
  assertUrlAllowed: vi.fn().mockResolvedValue(undefined),
}));

const VALID_ACCESS_KEY = 'https://user:pass@bridge.example.com/simplefin';
const SETUP_TOKEN = Buffer.from(
  'https://bridge.example.com/claim/abc',
).toString('base64');

const statusResponse = (status, body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: () => Promise.resolve(body),
});

const okResponse = body => statusResponse(200, body);

// The claim is a POST to the bridge; listing accounts is a GET. Route the mock
// by method so a test can stub one or both.
function mockFetch({ claim, accounts }) {
  global.fetch = vi
    .fn()
    .mockImplementation((url, options) =>
      Promise.resolve(options?.method === 'POST' ? claim : accounts),
    );
}

const post = path =>
  request(app).post(path).set('x-actual-token', 'valid-token');

// A Cloudflare 524 page, as served by the CDN in front of the hosted bridge
// when the bank connection stalls. The marker sits past the 200 characters the
// server is allowed to log, so a test can assert the body was clipped.
const CLOUDFLARE_524_PAGE = `<!DOCTYPE html><html lang="en-US"><head><title>beta-bridge.simplefin.org | Error 524: A timeout occurred</title><link rel="stylesheet"/></head><body class="cf-error-524"><div class="cf-wrapper"><div id="cf-error-details" class="cf-error-details-wrapper"><h1>Error 524</h1><p>A timeout occurred</p><p>The origin web server did not respond to Cloudflare within the allotted time.</p><p>Ray ID: 8f2c1d3b0a9e1234 &middot; Your IP: 203.0.113.42</p><p-marker-beyond-the-snippet>Version Error 1021</p-marker-beyond-the-snippet></div></div></body></html>`;

const bridgeResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: name => {
      const key = String(name).toLowerCase();
      if (key in headers) {
        return headers[key];
      }
      return key === 'content-type' ? 'text/html; charset=utf-8' : null;
    },
  },
  text: () => Promise.resolve(body),
});

const jsonResponse = (status, body) =>
  bridgeResponse(status, body, { 'content-type': 'application/json' });

const accountsPayload = {
  accounts: [
    {
      id: 'account-1',
      balance: '12.34',
      'balance-date': 1767139200,
      currency: 'USD',
      transactions: [],
      org: { name: 'Example Bank', domain: 'example.com' },
    },
  ],
  errors: [],
};

// Queue the GET responses for a single request. The last entry repeats, so a
// test can say "fail once, then succeed" or "keep failing".
function mockAccountsResponses(...responses) {
  const queue = [...responses];
  global.fetch = vi.fn().mockImplementation(() => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next() : Promise.resolve(next);
  });
}

const logged = () =>
  console.log.mock.calls
    .flat()
    .map(value =>
      value instanceof Error
        ? `${value.name}: ${value.stack ?? value.message}`
        : String(value),
    )
    .join('\n');

describe('app-simplefin', () => {
  beforeEach(() => {
    secretsService.set(SecretName.simplefin_token, null);
    secretsService.set(SecretName.simplefin_accessKey, null);
    vi.spyOn(console, 'log').mockImplementation(vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('/status', () => {
    it('reports configured when a real token is stored', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);

      const res = await post('/status');

      expect(res.body.data.configured).toBe(true);
    });

    it('reports not configured when the stored token is a Forbidden message', async () => {
      secretsService.set(
        SecretName.simplefin_token,
        'Forbidden (was it already claimed?)',
      );

      const res = await post('/status');

      expect(res.body.data.configured).toBe(false);
    });
  });

  describe('/accounts', () => {
    it('claims the token, trims the access key and returns accounts', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      mockFetch({
        claim: okResponse(`${VALID_ACCESS_KEY}\n`),
        accounts: okResponse(
          JSON.stringify({ accounts: [{ id: 'account-1' }] }),
        ),
      });

      const res = await post('/accounts');

      expect(res.body.data.accounts).toEqual([{ id: 'account-1' }]);
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBe(
        VALID_ACCESS_KEY,
      );
    });

    it('treats a "Forbidden (was it already claimed?)" claim response as invalid and does not persist it', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      mockFetch({ claim: okResponse('Forbidden (was it already claimed?)') });

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('INVALID_ACCESS_TOKEN');
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBeNull();
    });

    it('treats a blank claim response as invalid and does not persist it', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      mockFetch({ claim: okResponse('   \n') });

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('INVALID_ACCESS_TOKEN');
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBeNull();
    });

    it('re-claims when a stale Forbidden access key is cached', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      secretsService.set(
        SecretName.simplefin_accessKey,
        'Forbidden (was it already claimed?)',
      );
      mockFetch({
        claim: okResponse(VALID_ACCESS_KEY),
        accounts: okResponse(
          JSON.stringify({ accounts: [{ id: 'account-1' }] }),
        ),
      });

      const res = await post('/accounts');

      expect(res.body.data.accounts).toEqual([{ id: 'account-1' }]);
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBe(
        VALID_ACCESS_KEY,
      );
    });

    it('re-claims when a stale empty access key is cached', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      secretsService.set(SecretName.simplefin_accessKey, '');
      mockFetch({
        claim: okResponse(VALID_ACCESS_KEY),
        accounts: okResponse(
          JSON.stringify({ accounts: [{ id: 'account-1' }] }),
        ),
      });

      const res = await post('/accounts');

      expect(res.body.data.accounts).toEqual([{ id: 'account-1' }]);
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBe(
        VALID_ACCESS_KEY,
      );
    });

    it('re-claims when a stale non-URL access key is cached', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      secretsService.set(
        SecretName.simplefin_accessKey,
        '<html>Bad Gateway</html>',
      );
      mockFetch({
        claim: okResponse(VALID_ACCESS_KEY),
        accounts: okResponse(
          JSON.stringify({ accounts: [{ id: 'account-1' }] }),
        ),
      });

      const res = await post('/accounts');

      expect(res.body.data.accounts).toEqual([{ id: 'account-1' }]);
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBe(
        VALID_ACCESS_KEY,
      );
    });

    it('treats a claim response that is not an access URL as invalid and does not persist it', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      mockFetch({ claim: okResponse('<html>Service unavailable</html>') });

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('INVALID_ACCESS_TOKEN');
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBeNull();
    });

    it('rejects a token that does not decode to a claim URL without contacting SimpleFIN', async () => {
      secretsService.set(
        SecretName.simplefin_token,
        Buffer.from('not a claim url').toString('base64'),
      );
      global.fetch = vi.fn();

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('INVALID_ACCESS_TOKEN');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('treats a 403 Forbidden claim as an invalid token and does not persist it', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      mockFetch({
        claim: statusResponse(403, 'Forbidden (was it already claimed?)'),
      });

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('INVALID_ACCESS_TOKEN');
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBeNull();
    });

    it('reports SERVER_DOWN when the claim response is a redirect', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      mockFetch({ claim: statusResponse(302) });

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('SERVER_DOWN');
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBeNull();
    });

    it('reports SERVER_DOWN when the claim fails with a server error', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      mockFetch({
        claim: statusResponse(502, '<html>Bad Gateway</html>'),
      });

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('SERVER_DOWN');
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBeNull();
    });

    it('reports SERVER_DOWN when the claim request fails at the network level', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('SERVER_DOWN');
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBeNull();
    });

    it('reports SERVER_DOWN when the claim URL fails the SSRF preflight', async () => {
      secretsService.set(SecretName.simplefin_token, SETUP_TOKEN);
      assertUrlAllowed.mockRejectedValueOnce(
        new Error('Unable to resolve host: bridge.example.com'),
      );
      global.fetch = vi.fn();

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('SERVER_DOWN');
      expect(global.fetch).not.toHaveBeenCalled();
      expect(secretsService.get(SecretName.simplefin_accessKey)).toBeNull();
    });
  });

  describe('/transactions', () => {
    it('reports an invalid token when the cached access key is not an access URL', async () => {
      secretsService.set(
        SecretName.simplefin_accessKey,
        '<html>Bad Gateway</html>',
      );
      global.fetch = vi.fn();

      const res = await post('/transactions').send({
        accountId: 'account-1',
        startDate: '2026-07-01',
      });

      expect(res.body.data.error_code).toBe('INVALID_ACCESS_TOKEN');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('does not retry a 403 and reports the access token as invalid', async () => {
      secretsService.set(SecretName.simplefin_accessKey, VALID_ACCESS_KEY);
      mockAccountsResponses(bridgeResponse(403, 'Forbidden', {}));

      const res = await post('/transactions').send({
        accountId: 'account-1',
        startDate: '2026-07-01',
      });

      expect(res.body.data.error_code).toBe('INVALID_ACCESS_TOKEN');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  // The bridge sits behind Cloudflare, which answers with HTML error pages
  // (524 and friends) or empty bodies when a bank connection stalls. None of
  // that is JSON, and it is transient, so it must not surface as a parse error.
  describe('non-JSON bridge responses', () => {
    beforeEach(() => {
      secretsService.set(SecretName.simplefin_accessKey, VALID_ACCESS_KEY);
    });

    it('reports a Cloudflare 524 page as SERVER_DOWN after retrying, without a parse stack trace', async () => {
      mockAccountsResponses(bridgeResponse(524, CLOUDFLARE_524_PAGE));

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('SERVER_DOWN');
      // Three attempts: the initial call plus two retries.
      expect(global.fetch).toHaveBeenCalledTimes(3);

      const output = logged();
      expect(output).toContain('HTTP 524');
      expect(output).toContain('<!DOCTYPE html>');
      expect(output).not.toContain('marker-beyond-the-snippet');
      expect(output).not.toContain('SyntaxError');
      expect(output).not.toContain('Unexpected token');
      expect(output).not.toContain('    at ');
    });

    it('recovers when the bridge answers the retry with JSON', async () => {
      mockAccountsResponses(
        bridgeResponse(503, '<html>Service Unavailable</html>'),
        jsonResponse(200, JSON.stringify(accountsPayload)),
      );

      const res = await post('/accounts');

      expect(res.body.data.accounts).toEqual(accountsPayload.accounts);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(logged()).toContain('Retrying SimpleFIN request');
    });

    it('treats an empty 200 body as a retryable upstream error', async () => {
      mockAccountsResponses(jsonResponse(200, ''));

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('SERVER_DOWN');
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(logged()).toContain('empty body');
      expect(logged()).not.toContain('Unexpected end of JSON input');
    });

    it('treats a JSON response of the wrong shape as a non-JSON failure', async () => {
      mockAccountsResponses(jsonResponse(200, '[]'));

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('SERVER_DOWN');
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(logged()).toContain('unexpected JSON response');
    });

    it('does not retry a non-transient HTTP error', async () => {
      mockAccountsResponses(bridgeResponse(404, '<html>Not Found</html>'));

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('SERVER_DOWN');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(logged()).not.toContain('Retrying');
    });

    it('retries a connection failure and reports SERVER_DOWN when the bridge stays unreachable', async () => {
      mockAccountsResponses(() =>
        Promise.reject(
          Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(
              new Error('connect ECONNREFUSED 127.0.0.1:8901'),
              {
                code: 'ECONNREFUSED',
              },
            ),
          }),
        ),
      );

      const res = await post('/accounts');

      expect(res.body.data.error_code).toBe('SERVER_DOWN');
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(logged()).toContain('could not reach the bridge');
      expect(logged()).toContain('ECONNREFUSED');
    });

    it('waits for Retry-After before retrying a rate limited request', async () => {
      mockAccountsResponses(
        bridgeResponse(429, '<html>Too Many Requests</html>', {
          'retry-after': '1',
        }),
        jsonResponse(200, JSON.stringify(accountsPayload)),
      );

      const res = await post('/accounts');

      expect(res.body.data.accounts).toEqual(accountsPayload.accounts);
      expect(logged()).toContain('Retrying SimpleFIN request in 1000ms');
    });

    it('retries a 524 during a transaction sync', async () => {
      mockAccountsResponses(bridgeResponse(524, CLOUDFLARE_524_PAGE));

      const res = await post('/transactions').send({
        accountId: 'account-1',
        startDate: '2026-07-01',
      });

      expect(res.body.data.error_code).toBe('SERVER_DOWN');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('accepts a payload that omits the bridge errors array', async () => {
      const { errors, ...withoutErrors } = accountsPayload;
      expect(errors).toBeDefined();
      mockAccountsResponses(jsonResponse(200, JSON.stringify(withoutErrors)));

      const res = await post('/transactions').send({
        accountId: 'account-1',
        startDate: '2026-07-01',
      });

      expect(res.body.data.error_code).toBeUndefined();
      expect(res.body.data.startingBalance).toBe(1234);
    });
  });
});
