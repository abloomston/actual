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

/**
 * Maps an upstream failure onto the error payload the app turns into a
 * user-facing message. A redirect loop gets its own error type and names the
 * host that is looping, so the difference between "the bridge is flapping" and
 * "the bridge is down" survives all the way to the account screen.
 */
function upstreamFailure(e) {
  if (e instanceof TooManyRedirectsError) {
    return {
      error_type: TOO_MANY_REDIRECTS,
      error_code: TOO_MANY_REDIRECTS,
      reason: `The SimpleFIN bridge at ${e.host} kept redirecting instead of answering. This is usually temporary - try syncing again in a few minutes, and check the bridge configuration if it keeps happening.`,
    };
  }

  return {
    error_type: 'SERVER_DOWN',
    error_code: 'SERVER_DOWN',
    reason: 'There was an error communicating with SimpleFIN.',
  };
}

function serverDown(e, res) {
  if (e instanceof TooManyRedirectsError) {
    // An expected upstream failure with a message that already says everything:
    // log one line instead of a stack trace that points at our own fetch loop.
    console.log(e.message);
  } else {
    console.log(e);
  }

  res.send({
    status: 'ok',
    data: {
      ...upstreamFailure(e),
      status: 'rejected',
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

// Hops allowed before a bridge is declared to be looping, and how many times a
// looping request is retried before the failure is reported. A loop is almost
// always the bridge (or the reverse proxy in front of it) flapping rather than
// anything the user can fix, so it is treated as a retryable upstream failure.
const MAX_REDIRECTS = 5;
const REDIRECT_RETRY_ATTEMPTS = 3;
const REDIRECT_RETRY_BASE_DELAY_MS = 250;
const REDIRECT_RETRY_MAX_DELAY_MS = 1000;
const TOO_MANY_REDIRECTS = 'TOO_MANY_REDIRECTS';

class TooManyRedirectsError extends Error {
  constructor(host, maxRedirects, lastLocation) {
    super(
      `SimpleFIN bridge at ${host} redirected ${maxRedirects} times without answering (last redirect to ${lastLocation})`,
    );
    this.name = 'TooManyRedirectsError';
    this.host = host;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function redirectRetryDelayMs(attempt) {
  const backoff = Math.min(
    REDIRECT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 2),
    REDIRECT_RETRY_MAX_DELAY_MS,
  );
  // Jittered so syncs running against the same bridge don't retry in lockstep.
  return Math.round(backoff / 2 + Math.random() * (backoff / 2));
}

// One GET against the bridge, following redirects by hand so every hop is
// re-validated against the SSRF rules; fetch's automatic 'follow' would let a
// 3xx response redirect to a blocked address after only the initial URL was
// checked. Authorization is dropped once a redirect leaves the original origin
// (matching fetch's default cross-origin stripping) so the bridge credentials
// aren't leaked.
async function fetchFollowingRedirects(startUrl, sfin) {
  // Built per attempt: the Authorization header is deleted below when a
  // redirect leaves the original origin, and that must not leak into a retry.
  const headers = {
    Authorization: `Basic ${Buffer.from(
      `${sfin.username}:${sfin.password}`,
    ).toString('base64')}`,
  };

  let currentUrl = startUrl;
  for (let hop = 0; ; hop++) {
    await assertUrlAllowed(currentUrl, { allowPrivateNetwork: true });

    const response = await fetch(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
    });

    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }

    const nextUrl = new URL(location, currentUrl);
    if (hop >= MAX_REDIRECTS) {
      throw new TooManyRedirectsError(
        new URL(currentUrl).host,
        MAX_REDIRECTS,
        `${nextUrl.origin}${nextUrl.pathname}`,
      );
    }

    if (nextUrl.origin !== new URL(currentUrl).origin) {
      delete headers.Authorization;
    }
    currentUrl = nextUrl.toString();
  }
}

// Runs one bridge request, retrying a redirect loop with jittered exponential
// backoff. Bounded both by REDIRECT_RETRY_ATTEMPTS and, since every attempt is
// itself capped at MAX_REDIRECTS hops, keeps a looping bridge from stalling a
// sync past the timeout the app waits for.
async function requestAccounts(startUrl, sfin) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchFollowingRedirects(startUrl, sfin);
    } catch (error) {
      if (!(error instanceof TooManyRedirectsError)) {
        throw error;
      }

      const nextAttempt = attempt + 1;
      if (nextAttempt > REDIRECT_RETRY_ATTEMPTS) {
        console.log(
          `Giving up on SimpleFIN after ${attempt} attempts: ${error.message}`,
        );
        throw error;
      }

      const delay = redirectRetryDelayMs(nextAttempt);
      console.log(
        `Retrying SimpleFIN request in ${delay}ms (attempt ${nextAttempt}/${REDIRECT_RETRY_ATTEMPTS}): ${error.message}`,
      );
      await sleep(delay);
    }
  }
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

  const response = await requestAccounts(url.toString(), sfin);

  if (response.status === 403) {
    throw new Error('Forbidden');
  }

  const text = await response.text();
  try {
    const results = JSON.parse(text);
    results.sferrors = results.errors;
    results.hasError = false;
    results.errors = {};
    return results;
  } catch (e) {
    console.log(`Error parsing JSON response: ${text}`);
    throw e;
  }
}
