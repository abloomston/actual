import * as api from '@actual-app/api';

import {
  ensureDataDir,
  parseOptions,
  printUsage,
  readKeyringSecret,
} from './common.mjs';

const options = parseOptions();

if (options.help) {
  printUsage(
    'scripts/actual-node-client/budget-smoke-test.mjs',
    'The sync ID can also be supplied as the first positional argument.',
  );
  process.exit(0);
}

if (!options.syncId) {
  throw new Error(
    'A budget sync ID is required. Pass --sync-id <id> or set ACTUAL_SYNC_ID.',
  );
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

const encryptionPassword = await readKeyringSecret({
  serverURL: options.serverURL,
  kind: 'encryption-password',
});

await ensureDataDir(options.dataDir);

try {
  await api.init({
    dataDir: options.dataDir,
    serverURL: options.serverURL,
    password,
  });

  await api.downloadBudget(
    options.syncId,
    encryptionPassword ? { password: encryptionPassword } : undefined,
  );

  const [accounts, categories] = await Promise.all([
    api.getAccounts(),
    api.getCategories(),
  ]);

  await api.sync();

  console.log('Budget downloaded and read successfully.');
  console.log(
    JSON.stringify(
      {
        serverURL: options.serverURL,
        syncId: options.syncId,
        dataDir: options.dataDir,
        accountCount: accounts.length,
        categoryCount: categories.length,
        accountNames: accounts.map(account => account.name),
      },
      null,
      2,
    ),
  );
} catch (error) {
  const code = error?.code ? ` [${error.code}]` : '';
  throw new Error(`Actual API budget test failed${code}: ${error.message}`, {
    cause: error,
  });
} finally {
  await api.shutdown();
}
