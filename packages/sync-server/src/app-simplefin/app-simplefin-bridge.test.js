// End-to-end coverage of the bridge interaction: a real HTTP server stands in
// for the SimpleFIN bridge and the module talks to it with the real fetch, so
// status lines, content types and backoff are exercised rather than mocked.
import http from 'node:http';

import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { SecretName, secretsService } from '#services/secrets-service';

import { handlers as app } from './app-simplefin';

const CF_524_PAGE = `<!DOCTYPE html><html lang="en-US"><head><title>A timeout occurred</title></head><body>${'<p>The origin web server did not respond to Cloudflare within the allotted time.</p>'.repeat(10)}<p>END-OF-PAGE-MARKER</p></body></html>`;

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

let mode = 'unreachable-524';
let bridgeHits = 0;
let bridge;
let accessKey;

function respondWith(res, status, contentType, body, headers = {}) {
  res.writeHead(status, { 'content-type': contentType, ...headers });
  res.end(body);
}

beforeAll(async () => {
  bridge = http.createServer((req, res) => {
    bridgeHits++;

    if (mode === 'unreachable-524') {
      // What Cloudflare serves when the bank connection behind the bridge stalls.
      respondWith(res, 524, 'text/html; charset=utf-8', CF_524_PAGE);
      return;
    }
    if (mode === 'recovers-on-third-attempt' && bridgeHits < 3) {
      respondWith(res, 503, 'text/html', '<html>Service Unavailable</html>');
      return;
    }

    respondWith(res, 200, 'application/json', JSON.stringify(BRIDGE_ACCOUNTS));
  });

  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const { port } = bridge.address();
  accessKey = `http://user:pass@127.0.0.1:${String(port)}/simplefin`;
});

afterAll(() => {
  bridge.close();
});

beforeEach(() => {
  mode = 'unreachable-524';
  bridgeHits = 0;
  secretsService.set(SecretName.simplefin_token, null);
  secretsService.set(SecretName.simplefin_accessKey, accessKey);
  vi.spyOn(console, 'log').mockImplementation(vi.fn());
});

const logged = () =>
  console.log.mock.calls
    .flat()
    .map(value =>
      value instanceof Error
        ? `${value.name}: ${value.stack ?? value.message}`
        : String(value),
    )
    .join('\n');

const post = path =>
  request(app).post(path).set('x-actual-token', 'valid-token');

describe('app-simplefin against a real bridge', () => {
  it('retries the Cloudflare 524 page and reports SERVER_DOWN without a parse error', async () => {
    const startedAt = Date.now();
    const res = await post('/accounts');
    const elapsed = Date.now() - startedAt;

    expect(res.body.data.error_code).toBe('SERVER_DOWN');
    expect(bridgeHits).toBe(3);
    // Backoff happened, but stayed well inside the client's sync timeout.
    expect(elapsed).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(10000);

    const output = logged();
    expect(output).toContain('failed with HTTP 524');
    expect(output).toContain('<!DOCTYPE html>');
    expect(output).not.toContain('END-OF-PAGE-MARKER');
    expect(output).not.toContain('SyntaxError');
    expect(output).not.toContain('    at ');
  });

  it('completes the sync once the bridge recovers on a retry', async () => {
    mode = 'recovers-on-third-attempt';

    const res = await post('/transactions').send({
      accountId: 'account-1',
      startDate: '2026-07-01',
    });

    expect(bridgeHits).toBe(3);
    expect(logged()).toContain('failed with HTTP 503');
    expect(res.body.data.error_code).toBeUndefined();
    expect(res.body.data.startingBalance).toBe(1234);
  });
});
