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

// A looping bridge answers with another redirect rather than a body.
const redirectResponse = (location, status = 302) => ({
  ok: false,
  status,
  headers: {
    get: name => (name.toLowerCase() === 'location' ? location : null),
  },
  text: () => Promise.resolve(''),
});

// One pass over a redirect loop costs MAX_REDIRECTS (5) followed hops plus the
// hop that gives up, and each pass is retried REDIRECT_RETRY_ATTEMPTS (3) times.
const LOOP_HOPS_PER_ATTEMPT = 6;
const RETRY_ATTEMPTS = 3;

const BRIDGE_ACCOUNTS = {
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

// Everything the module wrote to the log, flattened into one string. Errors are
// rendered with their stack, so a logged stack trace is visible here.
const logged = () =>
  console.log.mock.calls
    .flat()
    .map(value =>
      value instanceof Error
        ? `${value.name}: ${value.stack ?? value.message}`
        : String(value),
    )
    .join('\n');

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

    it('reports TOO_MANY_REDIRECTS naming the looping bridge once the retries run out', async () => {
      secretsService.set(SecretName.simplefin_accessKey, VALID_ACCESS_KEY);
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          redirectResponse('https://bridge.example.com/simplefin/accounts'),
        );

      const res = await post('/accounts');

      expect(global.fetch).toHaveBeenCalledTimes(
        LOOP_HOPS_PER_ATTEMPT * RETRY_ATTEMPTS,
      );
      expect(res.body.data.error_code).toBe('TOO_MANY_REDIRECTS');
      expect(res.body.data.error_type).toBe('TOO_MANY_REDIRECTS');
      expect(res.body.data.reason).toContain('bridge.example.com');

      // The loop is an expected upstream failure: one line naming the host, no
      // stack trace pointing back at our own redirect follower.
      const output = logged();
      expect(output).toContain(
        'SimpleFIN bridge at bridge.example.com redirected 5 times',
      );
      expect(output).toContain('Giving up on SimpleFIN after 3 attempts');
      expect(output).not.toContain('    at ');
    });

    it('drops bridge credentials on a cross-origin redirect and rebuilds them for each retry', async () => {
      secretsService.set(SecretName.simplefin_accessKey, VALID_ACCESS_KEY);
      const seen = [];
      global.fetch = vi.fn().mockImplementation((url, options) => {
        seen.push({ url, authorization: options?.headers?.Authorization });
        // The bridge bounces to another origin, which then loops forever.
        return Promise.resolve(
          new URL(url).hostname === 'other.example.com'
            ? redirectResponse('/simplefin/accounts')
            : redirectResponse('https://other.example.com/simplefin/accounts'),
        );
      });

      const res = await post('/accounts');

      const basic = `Basic ${Buffer.from('user:pass').toString('base64')}`;
      expect(res.body.data.error_code).toBe('TOO_MANY_REDIRECTS');
      // The credential reaches the bridge it belongs to and no further.
      expect(seen[0].authorization).toBe(basic);
      const loopedHops = seen.filter(s =>
        s.url.startsWith('https://other.example.com'),
      );
      expect(loopedHops.length).toBeGreaterThan(0);
      expect(loopedHops.every(s => s.authorization === undefined)).toBe(true);
      // Retrying must not reuse the header state of the attempt that gave up.
      const firstHops = seen.filter(s =>
        s.url.startsWith('https://bridge.example.com'),
      );
      expect(firstHops).toHaveLength(RETRY_ATTEMPTS);
      expect(firstHops.every(s => s.authorization === basic)).toBe(true);
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

    it('retries a redirect loop and finishes the sync when the bridge recovers', async () => {
      secretsService.set(SecretName.simplefin_accessKey, VALID_ACCESS_KEY);
      let hops = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        hops += 1;
        if (hops <= LOOP_HOPS_PER_ATTEMPT) {
          return Promise.resolve(
            redirectResponse('https://bridge.example.com/simplefin/accounts'),
          );
        }
        return Promise.resolve(okResponse(JSON.stringify(BRIDGE_ACCOUNTS)));
      });

      const res = await post('/transactions').send({
        accountId: 'account-1',
        startDate: '2026-07-01',
      });

      expect(global.fetch).toHaveBeenCalledTimes(LOOP_HOPS_PER_ATTEMPT + 1);
      expect(res.body.data.error_code).toBeUndefined();
      expect(res.body.data.startingBalance).toBe(1234);
      expect(logged()).toContain('Retrying SimpleFIN request in');
    });

    it('reports TOO_MANY_REDIRECTS for a looping bridge instead of failing the sync outright', async () => {
      secretsService.set(SecretName.simplefin_accessKey, VALID_ACCESS_KEY);
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          redirectResponse('https://bridge.example.com/simplefin/accounts'),
        );

      const res = await post('/transactions').send({
        accountId: 'account-1',
        startDate: '2026-07-01',
      });

      expect(global.fetch).toHaveBeenCalledTimes(
        LOOP_HOPS_PER_ATTEMPT * RETRY_ATTEMPTS,
      );
      expect(res.body.data.error_code).toBe('TOO_MANY_REDIRECTS');
      expect(res.body.data.reason).toContain('bridge.example.com');
      // The reason travels to the app, which shows it when linking accounts.
      expect(res.body.data.reason).toContain('usually temporary');
    });
  });
});
