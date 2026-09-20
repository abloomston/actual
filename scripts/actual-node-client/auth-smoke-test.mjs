import * as api from '@actual-app/api';

import {
  ensureDataDir,
  parseOptions,
  printUsage,
  readKeyringSecret,
} from './common.mjs';

const options = parseOptions();

if (options.help) {
  printUsage('scripts/actual-node-client/auth-smoke-test.mjs');
  process.exit(0);
}

const password = await readKeyringSecret({
  serverURL: options.serverURL,
  kind: 'server-password',
});

if (!password) {
  throw new Error(
    'No server password was found in the keyring. Run setup-keyring.mjs first.',
  );
}

await ensureDataDir(options.dataDir);

try {
  await api.init({
    dataDir: options.dataDir,
    serverURL: options.serverURL,
    password,
  });

  const budgets = await api.getBudgets();
  const summary = budgets.map(budget => ({
    name: budget.name,
    syncId: budget.groupId,
    state: budget.state,
  }));

  console.log('Authenticated successfully.');
  console.log(
    JSON.stringify({ serverURL: options.serverURL, budgets: summary }, null, 2),
  );
} catch (error) {
  const code = error?.code ? ` [${error.code}]` : '';
  throw new Error(
    `Actual API authentication test failed${code}: ${error.message}`,
    {
      cause: error,
    },
  );
} finally {
  await api.shutdown();
}
