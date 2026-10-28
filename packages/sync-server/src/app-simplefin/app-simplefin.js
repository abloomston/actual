import express from 'express';

import { handleError } from '#app-gocardless/util/handle-error';
import { SecretName, secretsService } from '#services/secrets-service';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';
import { assertUrlAllowed } from '#util/ssrf';

const app = express();
export { app as handlers };
app.use(requestLoggerMiddleware);
app.use(express.json());
app.use(validateSessionMiddleware);

app.post(
  '/status',
  handleError(async (req, res) => {
    const token = secretsService.get(SecretName.simplefin_token);
    const configured = token != null && !isForbidden(token);

    res.send({
      status: 'ok',
      data: {
        configured,
      },
    });
  }),
);

app.post(
  '/accounts',
  handleError(async (req, res) => {
    let accessKey = secretsService.get(SecretName.simplefin_accessKey);

    if (isInvalidAccessKey(accessKey)) {
      const token = secretsService.get(SecretName.simplefin_token);
      if (token == null || isForbidden(token)) {
        invalidToken(res);
        return;
      }

      const claimUrl = decodeClaimUrl(token);
      if (claimUrl == null) {
        console.log(
          'SimpleFIN setup token does not decode to a claim URL - re-enter the token',
        );
        invalidToken(res);
        return;
      }

      try {
        accessKey = await claimAccessKey(claimUrl);
      } catch (e) {
        console.log('Failed to claim the SimpleFIN setup token:');
        serverDown(e, res);
        return;
      }

      if (isInvalidAccessKey(accessKey)) {
        console.log(
          `SimpleFIN rejected the setup token claim: ${
            accessKey.slice(0, 200) || '(empty response)'
          }`,
        );
        invalidToken(res);
        return;
      }

      secretsService.set(SecretName.simplefin_accessKey, accessKey);
    }

    try {
      const accounts = await getAccounts(accessKey, null, null, null, true);

      res.send({
        status: 'ok',
        data: {
          accounts: accounts.accounts,
        },
      });
    } catch (e) {
      serverDown(e, res);
      return;
    }
  }),
);

app.post(
  '/transactions',
  handleError(async (req, res) => {
    const { accountId, startDate } = req.body || {};

    const accessKey = secretsService.get(SecretName.simplefin_accessKey);

    if (isInvalidAccessKey(accessKey)) {
      invalidToken(res);
      return;
    }

    if (Array.isArray(accountId) !== Array.isArray(startDate)) {
      console.log({ accountId, startDate });
      throw new Error(
        'accountId and startDate must either both be arrays or both be strings',
      );
    }
    if (Array.isArray(accountId) && accountId.length !== startDate.length) {
      console.log({ accountId, startDate });
      throw new Error('accountId and startDate arrays must be the same length');
    }

    const earliestStartDate = Array.isArray(startDate)
      ? startDate.reduce((a, b) => (a < b ? a : b))
      : startDate;
    let results;
    try {
      results = await getTransactions(
        accessKey,
        Array.isArray(accountId) ? accountId : [accountId],
        new Date(earliestStartDate),
      );
    } catch (e) {
      if (isForbidden(e.message)) {
        invalidToken(res);
      } else {
        serverDown(e, res);
      }
      return;
    }

    let response = {};
    if (Array.isArray(accountId)) {
      for (let i = 0; i < accountId.length; i++) {
        const id = accountId[i];
        response[id] = getAccountResponse(results, id, new Date(startDate[i]));
      }
    } else {
      response = getAccountResponse(results, accountId, new Date(startDate));
    }

    if (results.hasError) {
      res.send({
        status: 'ok',
        data: !Array.isArray(accountId)
          ? results.errors[accountId][0]
          : {
              ...response,
              errors: results.errors,
            },
      });
      return;
    }

    res.send({
      status: 'ok',
      data: response,
    });
  }),
);

function logAccountError(results, accountId, data) {
  const errors = results.errors[accountId] || [];
  errors.push(data);
  results.errors[accountId] = errors;
  results.hasError = true;
}

function getAccountResponse(results, accountId, startDate) {
  const account =
    !results?.accounts || results.accounts.find(a => a.id === accountId);
  if (!account) {
    console.log(
      `The account "${accountId}" was not found. Here were the accounts returned:`,
    );
    if (results?.accounts) {
      results.accounts.forEach(a => console.log(`${a.id} - ${a.org.name}`));
    }
    logAccountError(results, accountId, {
      error_type: 'ACCOUNT_MISSING',
      error_code: 'ACCOUNT_MISSING',
      reason: `The account "${accountId}" was not found. Try unlinking and relinking the account.`,
    });
    return;
  }

  const needsAttention = results.sferrors.find(e =>
    e.startsWith(`Connection to ${account.org.name} may need attention`),
  );
  if (needsAttention) {
    logAccountError(results, accountId, {
      error_type: 'ACCOUNT_NEEDS_ATTENTION',
      error_code: 'ACCOUNT_NEEDS_ATTENTION',
      reason:
        'The account needs your attention at <a href="https://bridge.simplefin.org/auth/login">SimpleFIN</a>.',
    });
  }

  const startingBalance = parseInt(account.balance.replace('.', ''));
  const date = getDate(new Date(account['balance-date'] * 1000));

  const balances = [
    {
      balanceAmount: {
        amount: account.balance,
        currency: account.currency,
      },
      balanceType: 'expected',
      referenceDate: date,
    },
    {
      balanceAmount: {
        amount: account.balance,
        currency: account.currency,
      },
      balanceType: 'interimAvailable',
      referenceDate: date,
    },
  ];

  const all = [];
  const booked = [];
  const pending = [];

  for (const trans of account.transactions) {
    const newTrans = {};

    let dateToUse = 0;

    if (trans.pending ?? trans.posted === 0) {
      newTrans.booked = false;
      dateToUse = trans.transacted_at;
    } else {
      newTrans.booked = true;
      dateToUse = trans.posted;
    }

    const transactionDate = new Date(dateToUse * 1000);

    if (transactionDate < startDate) {
      continue;
    }

    newTrans.sortOrder = dateToUse;
    newTrans.date = getDate(transactionDate);
    newTrans.payeeName = trans.payee;
    newTrans.notes = trans.description;
    newTrans.transactionAmount = { amount: trans.amount, currency: 'USD' };
    newTrans.transactionId = trans.id;
    newTrans.valueDate = newTrans.bookingDate;

    if (trans.transacted_at) {
      newTrans.transactedDate = getDate(new Date(trans.transacted_at * 1000));
    }

    if (trans.posted) {
      newTrans.postedDate = getDate(new Date(trans.posted * 1000));
    }

    if (newTrans.booked) {
      booked.push(newTrans);
    } else {
      pending.push(newTrans);
    }
    all.push(newTrans);
  }

  const sortFunction = (a, b) => b.sortOrder - a.sortOrder;

  const bookedSorted = booked.sort(sortFunction);
  const pendingSorted = pending.sort(sortFunction);
  const allSorted = all.sort(sortFunction);

  return {
    balances,
    startingBalance,
    transactions: {
      all: allSorted,
      booked: bookedSorted,
      pending: pendingSorted,
    },
  };
}

function invalidToken(res) {
  res.send({
    status: 'ok',
    data: {
      error_type: 'INVALID_ACCESS_TOKEN',
      error_code: 'INVALID_ACCESS_TOKEN',
      status: 'rejected',
      reason:
        'Invalid SimpleFIN access token.  Reset the token and re-link any broken accounts.',
    },
  });
}

function serverDown(e, res) {
  if (e instanceof SimpleFinUpstreamError) {
    // Expected upstream failures: a single line is enough, no stack trace.
    console.log(e.message);
  } else {
    console.log(e);
  }
  res.send({
    status: 'ok',
    data: {
      error_type: 'SERVER_DOWN',
      error_code: 'SERVER_DOWN',
      status: 'rejected',
      reason: 'There was an error communicating with SimpleFIN.',
    },
  });
}

const ACCESS_KEY_FORMAT = /^.*\/\/.*:.*@.*$/;

function parseAccessKey(accessKey) {
  let scheme = null;
  let rest = null;
  let auth = null;
  let username = null;
  let password = null;
  let baseUrl = null;
  if (!accessKey || !ACCESS_KEY_FORMAT.test(accessKey)) {
    console.log('Invalid SimpleFIN access key');
    throw new Error(`Invalid access key`);
  }
  [scheme, rest] = accessKey.split('//');
  [auth, rest] = rest.split('@');
  [username, password] = auth.split(':');
  baseUrl = `${scheme}//${rest}`;
  return {
    baseUrl,
    username,
    password,
  };
}

function decodeClaimUrl(base64Token) {
  const decoded = Buffer.from(base64Token, 'base64').toString();

  let url;
  try {
    url = new URL(decoded);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  return decoded;
}

async function claimAccessKey(claimUrl) {
  // Self-hosters may run their own SimpleFIN bridge on the local network, so
  // private addresses are allowed here; cloud metadata and other always-blocked
  // ranges are still rejected.
  await assertUrlAllowed(claimUrl, { allowPrivateNetwork: true });

  // don't auto-follow redirects for SSRF safety
  const response = await fetch(claimUrl, {
    method: 'POST',
    redirect: 'manual',
  });

  if (!response.ok && response.status !== 403) {
    throw new Error(`SimpleFIN claim failed with HTTP ${response.status}`);
  }

  return (await response.text()).trim();
}

function isForbidden(value) {
  return typeof value === 'string' && value.startsWith('Forbidden');
}

function isInvalidAccessKey(accessKey) {
  return (
    typeof accessKey !== 'string' ||
    isForbidden(accessKey) ||
    !ACCESS_KEY_FORMAT.test(accessKey)
  );
}

async function getTransactions(accessKey, accounts, startDate, endDate) {
  const now = new Date();
  startDate = startDate || new Date(now.getFullYear(), now.getMonth(), 1);
  endDate = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 1);
  console.log(`${getDate(startDate)} - ${getDate(endDate)}`);
  return await getAccounts(accessKey, accounts, startDate, endDate);
}

function getDate(date) {
  return date.toISOString().split('T')[0];
}

function normalizeDate(date) {
  return (date.valueOf() - date.getTimezoneOffset() * 60 * 1000) / 1000;
}

// A transient upstream failure is safe to try again: timeouts, rate limits and
// anything 5xx - which includes the Cloudflare-only statuses (520-527) that the
// CDN in front of the hosted bridge serves as an HTML error page whenever a
// bank connection behind it stalls.
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 4000;
// The app waits 60s for a single-account sync (5 min for a batch), so one
// bridge call must not spend the whole window retrying.
const RETRY_BUDGET_MS = 45000;
// A bridge asking for a longer pause than this is not worth waiting out.
const RETRY_MAX_AFTER_MS = 15000;
const BODY_SNIPPET_LIMIT = 200;
const REQUEST_DESCRIPTION = 'accounts request';

// Raised instead of a JSON.parse SyntaxError when the bridge answers with
// something Actual cannot use: a Cloudflare error page, an empty 200, a JSON
// payload of the wrong shape, or a connection that never completed.
class SimpleFinUpstreamError extends Error {
  constructor(message, { status, retryable, retryAfterMs = null }) {
    super(message);
    this.name = 'SimpleFinUpstreamError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncate(value, limit) {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// A description of the body fit for one log line: whitespace collapsed and
// clipped, so a whole HTML error page never lands in the server logs.
function describeBody(text, contentType) {
  const snippet = (text ?? '').replace(/\s+/g, ' ').trim();
  const parts = [];
  if (contentType) {
    parts.push(`content-type ${contentType}`);
  }
  parts.push(
    snippet === ''
      ? 'empty body'
      : `body ${truncate(snippet, BODY_SNIPPET_LIMIT)}`,
  );
  return parts.join(', ');
}

function isJsonContentType(contentType) {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  // Self-hosted bridges sometimes omit the header; treat unknown as JSON and
  // let the parse attempt decide.
  if (type === '') {
    return true;
  }
  return (
    type === 'application/json' ||
    type.endsWith('/json') ||
    type.endsWith('+json')
  );
}

function parseRetryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) {
    return null;
  }
  return Math.min(delay, RETRY_MAX_AFTER_MS);
}

function retryDelayMs(error, attempt) {
  if (error.retryAfterMs != null) {
    return error.retryAfterMs;
  }

  const backoff = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** (attempt - 2),
    RETRY_MAX_DELAY_MS,
  );
  // Jittered so syncs running against the same bridge don't retry in lockstep.
  return Math.round(backoff / 2 + Math.random() * (backoff / 2));
}

// Runs one bridge call, retrying transient upstream failures with jittered
// exponential backoff. The whole sequence is bounded by both RETRY_ATTEMPTS and
// RETRY_BUDGET_MS so a stalled bridge cannot push a sync past the app's timeout.
async function withUpstreamRetry(request) {
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof SimpleFinUpstreamError) || !error.retryable) {
        throw error;
      }

      const nextAttempt = attempt + 1;
      const delay = retryDelayMs(error, nextAttempt);
      if (nextAttempt > RETRY_ATTEMPTS) {
        console.log(
          `Giving up on SimpleFIN after ${attempt} attempts: ${error.message}`,
        );
        throw error;
      }
      if (Date.now() - startedAt + delay > RETRY_BUDGET_MS) {
        console.log(
          `Giving up on SimpleFIN after ${attempt} attempts (retry budget exhausted): ${error.message}`,
        );
        throw error;
      }

      console.log(
        `Retrying SimpleFIN request in ${delay}ms (attempt ${nextAttempt}/${RETRY_ATTEMPTS}): ${error.message}`,
      );
      await sleep(delay);
    }
  }
}

// Read the bridge response as JSON, classifying anything unusable as a
// SimpleFinUpstreamError rather than letting JSON.parse throw a SyntaxError.
async function parseAccountsResponse(response) {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  let parsed;
  let isJson = false;
  if (response.ok && isJsonContentType(contentType)) {
    try {
      parsed = JSON.parse(text);
      isJson = true;
    } catch {
      // Reported through the shared classification below.
    }

    if (isJson && isPlainObject(parsed)) {
      return {
        ...parsed,
        sferrors: Array.isArray(parsed.errors) ? parsed.errors : [],
        hasError: false,
        errors: {},
      };
    }
  }

  const reason = !response.ok
    ? `failed with HTTP ${response.status}`
    : isJson
      ? 'returned an unexpected JSON response'
      : 'returned a non-JSON response';

  throw new SimpleFinUpstreamError(
    `SimpleFIN ${REQUEST_DESCRIPTION} ${reason} (${describeBody(text, contentType)})`,
    {
      status: response.status,
      // A 2xx body Actual cannot use is treated as a glitch; an HTTP error is
      // only retried when its status says the upstream is temporarily broken.
      retryable: response.ok || isRetryableStatus(response.status),
      retryAfterMs: parseRetryAfterMs(response),
    },
  );
}

function errorDetail(error) {
  const cause = error?.cause?.message;
  return cause ? `${error.message}: ${cause}` : String(error?.message ?? error);
}

async function fetchAccounts(url, sfin) {
  // Built per attempt: Authorization is dropped below when a redirect leaves
  // the original origin, and that must not leak into the next retry.
  const headers = {
    Authorization: `Basic ${Buffer.from(
      `${sfin.username}:${sfin.password}`,
    ).toString('base64')}`,
  };

  // Follow redirects manually so every hop is re-validated against the SSRF
  // rules; fetch's automatic 'follow' would let a 3xx response redirect to a
  // blocked address after only the initial URL was checked. Authorization is
  // dropped once a redirect leaves the original origin (matching fetch's
  // default cross-origin stripping) so the bridge credentials aren't leaked.
  const MAX_REDIRECTS = 5;
  let currentUrl = url;
  let response;
  for (let hop = 0; ; hop++) {
    await assertUrlAllowed(currentUrl, { allowPrivateNetwork: true });

    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
      });
    } catch (error) {
      throw new SimpleFinUpstreamError(
        `SimpleFIN ${REQUEST_DESCRIPTION} could not reach the bridge (${errorDetail(error)})`,
        { status: 0, retryable: true },
      );
    }

    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      break;
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error('Too many redirects');
    }

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== new URL(currentUrl).origin) {
      delete headers.Authorization;
    }
    currentUrl = nextUrl.toString();
  }

  return response;
}

async function getAccounts(
  accessKey,
  accounts,
  startDate,
  endDate,
  noTransactions = false,
) {
  const sfin = parseAccessKey(accessKey);

  const params = new URLSearchParams();
  if (!noTransactions) {
    if (startDate) {
      params.append('start-date', normalizeDate(startDate));
    }
    if (endDate) {
      params.append('end-date', normalizeDate(endDate));
    }
    params.append('pending', '1');
  } else {
    params.append('balances-only', '1');
  }

  if (accounts) {
    for (const id of accounts) {
      params.append('account', id);
    }
  }

  const url = new URL(`${sfin.baseUrl}/accounts`);
  url.search = params.toString();

  return await withUpstreamRetry(async () => {
    const response = await fetchAccounts(url.toString(), sfin);

    if (response.status === 403) {
      // Thrown as a plain Error: a rejected credential is not worth retrying,
      // and callers look for this message to report an invalid token.
      throw new Error('Forbidden');
    }

    return await parseAccountsResponse(response);
  });
}
