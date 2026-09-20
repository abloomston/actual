import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { DEFAULT_SERVER_URL } from './common.mjs';
import { TOOL_DEFINITIONS } from './mcp-api.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, '../..');
const serverScript = resolve(scriptDir, 'mcp-server.mjs');

function parseOptions(argv = process.argv.slice(2)) {
  const options = {
    serverURL: process.env.ACTUAL_SERVER_URL || DEFAULT_SERVER_URL,
    syncId: process.env.ACTUAL_SYNC_ID || null,
    dataDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--server-url') {
      options.serverURL = requiredValue(argv, ++index, argument);
    } else if (argument.startsWith('--server-url=')) {
      options.serverURL = argument.slice('--server-url='.length);
    } else if (argument === '--sync-id') {
      options.syncId = requiredValue(argv, ++index, argument);
    } else if (argument.startsWith('--sync-id=')) {
      options.syncId = argument.slice('--sync-id='.length);
    } else if (argument === '--data-dir') {
      options.dataDir = requiredValue(argv, ++index, argument);
    } else if (argument.startsWith('--data-dir=')) {
      options.dataDir = argument.slice('--data-dir='.length);
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function printUsage() {
  console.log('Usage: node scripts/actual-node-client/mcp-e2e.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log(`  --server-url <url>  Default: ${DEFAULT_SERVER_URL}`);
  console.log(
    '  --sync-id <id>      Existing server budget used for the initial download',
  );
  console.log(
    '  --data-dir <path>   Keep the temporary MCP cache at this path',
  );
}

function parseToolResult(result, name) {
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (result.isError) {
    throw new Error(`${name} failed: ${text || 'unknown MCP error'}`);
  }
  if (!text) return null;
  return JSON.parse(text);
}

function createCaller(client) {
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return parseToolResult(result, name);
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findBudget(budgets, name) {
  return budgets.find(budget => budget.name === name);
}

async function safeCall(call, name, args) {
  try {
    await call(name, args);
  } catch {
    // Cleanup is best effort. The primary test failure is reported separately.
  }
}

async function removeBudget(call, budget) {
  if (!budget) return;
  if (budget.cloudFileId) {
    await safeCall(call, 'actual_delete_budget_file', {
      cloudFileId: budget.cloudFileId,
    });
  }
  if (budget.id) {
    await safeCall(call, 'actual_delete_budget_file', { id: budget.id });
  }
}

async function run() {
  const options = parseOptions();
  if (options.help) {
    printUsage();
    return;
  }

  const dataDir =
    options.dataDir || (await mkdtemp(`${tmpdir()}/actual-node-mcp-e2e-`));
  const shouldRemoveDataDir = !options.dataDir;
  const environment = Object.fromEntries(
    Object.entries({
      ...process.env,
      ACTUAL_SERVER_URL: options.serverURL,
      ACTUAL_MCP_DATA_DIR: dataDir,
      ACTUAL_NODE_DATA_DIR: dataDir,
    }).filter(([, value]) => value !== undefined),
  );

  const client = new Client({
    name: 'actual-budget-mcp-e2e',
    version: '0.1.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    cwd: repositoryRoot,
    env: environment,
    stderr: 'ignore',
  });

  let call;
  let createdBudgetName;
  let helperBudgetName;
  let createdBudget;
  let helperBudget;
  let importedBudget;

  try {
    await client.connect(transport);
    call = createCaller(client);

    const listed = await client.listTools();
    const listedNames = new Set(listed.tools.map(tool => tool.name));
    for (const definition of TOOL_DEFINITIONS) {
      assert(
        listedNames.has(definition.name),
        `MCP tool was not registered: ${definition.name}`,
      );
    }
    assert(
      listed.tools.length === TOOL_DEFINITIONS.length,
      `Expected ${TOOL_DEFINITIONS.length} tools, got ${listed.tools.length}`,
    );
    console.log(`MCP handshake passed with ${listed.tools.length} tools.`);

    let syncId = options.syncId;
    if (!syncId) {
      const budgets = await call('actual_get_budgets');
      const remoteBudget = budgets.find(
        budget => budget.state === 'remote' && budget.groupId,
      );
      assert(
        remoteBudget,
        'No remote budget was found. Pass --sync-id for an existing server budget.',
      );
      syncId = remoteBudget.groupId;
    }

    const initialState = await call('actual_init', {
      serverURL: options.serverURL,
      dataDir,
      syncId,
      downloadBudget: true,
    });
    assert(initialState.initialized === true, 'MCP client did not initialize');
    assert(initialState.loadedBudgetId, 'Initial budget was not loaded');
    console.log('Keyring authentication and initial budget download passed.');

    const suffix = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    createdBudgetName = `MCP E2E ${suffix}`;

    // runImport creates a new local budget, runs the callback, finishes it, and
    // uploads it to the running sync server.
    await call('actual_run_import', {
      budgetName: createdBudgetName,
      operations: [],
    });
    let budgets = await call('actual_get_budgets');
    createdBudget = findBudget(budgets, createdBudgetName);
    assert(createdBudget, 'The imported test budget was not uploaded');
    assert(
      createdBudget.cloudFileId,
      'The imported test budget has no cloud id',
    );
    console.log(`Created server budget: ${createdBudgetName}`);

    // Exercise the explicit budget-file helper too, then remove that helper
    // file before continuing with the main test file.
    helperBudgetName = `MCP helper ${suffix}`;
    await call('actual_create_budget_file', { budgetName: helperBudgetName });
    budgets = await call('actual_get_budgets');
    helperBudget = findBudget(budgets, helperBudgetName);
    assert(helperBudget?.cloudFileId, 'The helper budget was not uploaded');
    await removeBudget(call, helperBudget);
    helperBudget = null;
    await call('actual_download_budget', {
      syncId: createdBudget.groupId,
      useEncryptionPassword: true,
    });

    await call('actual_load_budget', { id: createdBudget.id });
    const months = await call('actual_get_budget_months');
    const month = months.at(-1) || new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;

    const baseGroupId = await call('actual_create_category_group', {
      group: { name: `MCP base category group ${suffix}` },
    });
    const baseCategoryName = `MCP base category ${suffix}`;
    const baseCategoryId = await call('actual_create_category', {
      category: { name: baseCategoryName, group_id: baseGroupId },
    });

    const categoryGroupId = await call('actual_create_category_group', {
      group: { name: `MCP category group ${suffix}` },
    });
    const categoryId = await call('actual_create_category', {
      category: {
        name: `MCP category ${suffix}`,
        group_id: categoryGroupId,
      },
    });
    await call('actual_update_category', {
      id: categoryId,
      fields: { name: `MCP updated category ${suffix}` },
    });
    await call('actual_set_budget_amount', {
      month,
      categoryId,
      value: 12345,
    });
    await call('actual_set_budget_carryover', {
      month,
      categoryId,
      flag: true,
    });
    const budgetMonth = await call('actual_get_budget_month', { month });
    assert(budgetMonth, 'Budget month query returned no result');
    await call('actual_update_note', {
      id: categoryId,
      note: 'MCP e2e note',
    });
    assert(
      (await call('actual_get_note', { id: categoryId })).note ===
        'MCP e2e note',
      'Category note was not updated',
    );
    await call('actual_delete_category', { id: categoryId });
    await call('actual_delete_category_group', { id: categoryGroupId });

    const accountGroupId = await call('actual_create_account_group', {
      group: { name: `MCP account group ${suffix}` },
    });
    await call('actual_update_account_group', {
      id: accountGroupId,
      fields: { name: `MCP updated account group ${suffix}` },
    });
    await call('actual_get_account_groups');
    await call('actual_delete_account_group', { id: accountGroupId });

    const accountId = await call('actual_create_account', {
      account: { name: `MCP checking ${suffix}`, offbudget: false },
      initialBalance: 1000,
    });
    const transferAccountId = await call('actual_create_account', {
      account: { name: `MCP transfer ${suffix}`, offbudget: true },
      initialBalance: 0,
    });
    assert(
      (await call('actual_get_account_balance', { id: accountId })) === 1000,
      'Initial account balance was incorrect',
    );
    await call('actual_update_account', {
      id: accountId,
      fields: { name: `MCP updated checking ${suffix}` },
    });
    await call('actual_add_transactions', {
      accountId,
      transactions: [
        {
          date: `${monthStart}`,
          amount: 100,
          notes: 'MCP e2e transaction one',
        },
        {
          date: `${monthStart}`,
          amount: 100,
          notes: 'MCP e2e transaction two',
        },
      ],
      learnCategories: false,
      runTransfers: false,
    });
    let transactions = await call('actual_get_transactions', {
      accountId,
      startDate: '2000-01-01',
      endDate: '2099-12-31',
    });
    const addedTransactions = transactions.filter(
      transaction => !transaction.starting_balance_flag,
    );
    assert(
      addedTransactions.length === 2,
      `Transactions were not added: ${JSON.stringify(transactions)}`,
    );
    const mergedTransactionId = await call('actual_merge_transactions', {
      ids: [addedTransactions[0].id, addedTransactions[1].id],
    });
    transactions = await call('actual_get_transactions', {
      accountId,
      startDate: '2000-01-01',
      endDate: '2099-12-31',
    });
    assert(
      transactions.some(transaction => transaction.id === mergedTransactionId),
      'Merged transaction was not retained',
    );
    await call('actual_update_transaction', {
      id: mergedTransactionId,
      fields: { amount: 350 },
    });
    const imported = await call('actual_import_transactions', {
      accountId,
      transactions: [
        {
          account: accountId,
          date: monthStart,
          imported_id: `mcp-import-${suffix}`,
          amount: 50,
          notes: 'MCP imported transaction',
        },
      ],
    });
    assert(imported.added?.length === 1, 'Imported transaction was not added');
    await call('actual_delete_transaction', { id: imported.added[0] });
    await call('actual_run_bank_sync', { accountId });
    await call('actual_close_account', {
      id: accountId,
      transferAccountId,
    });
    await call('actual_reopen_account', { id: accountId });
    await call('actual_delete_account', { id: transferAccountId });

    const payeeId = await call('actual_create_payee', {
      payee: { name: `MCP payee ${suffix}` },
    });
    const mergePayeeId = await call('actual_create_payee', {
      payee: { name: `MCP merge payee ${suffix}` },
    });
    await call('actual_update_payee', {
      id: payeeId,
      fields: { name: `MCP updated payee ${suffix}` },
    });
    await call('actual_get_payees');
    await call('actual_get_common_payees');
    await call('actual_merge_payees', {
      targetId: payeeId,
      mergeIds: [mergePayeeId],
    });

    const tagId = await call('actual_create_tag', {
      tag: { tag: `mcp-tag-${suffix}`, color: '#123456' },
    });
    const deleteTagId = await call('actual_create_tag', {
      tag: { tag: `mcp-delete-tag-${suffix}` },
    });
    await call('actual_update_tag', {
      id: tagId,
      fields: { description: 'MCP e2e tag' },
    });
    await call('actual_get_tags');
    await call('actual_delete_tag', { id: deleteTagId });
    await call('actual_delete_tag', { id: tagId });

    const rule = await call('actual_create_rule', {
      rule: {
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
          { field: 'payee', op: 'is', value: `MCP updated payee ${suffix}` },
        ],
        actions: [{ op: 'set', field: 'category', value: baseCategoryId }],
      },
    });
    await call('actual_get_rules');
    await call('actual_get_payee_rules', { id: `MCP updated payee ${suffix}` });
    await call('actual_update_rule', {
      rule: { ...rule, stage: 'post', conditionsOp: 'or' },
    });
    await call('actual_delete_rule', { id: rule.id });

    const scheduleId = await call('actual_create_schedule', {
      schedule: {
        name: `MCP schedule ${suffix}`,
        posts_transaction: false,
        amount: 4000,
        amountOp: 'is',
        date: new Date().toISOString().slice(0, 10),
      },
    });
    const recurringScheduleId = await call('actual_create_schedule', {
      schedule: {
        name: `MCP recurring schedule ${suffix}`,
        posts_transaction: true,
        amountOp: 'is',
        date: {
          frequency: 'monthly',
          interval: 1,
          start: new Date().toISOString().slice(0, 10),
          patterns: [],
          skipWeekend: false,
          weekendSolveMode: 'after',
          endMode: 'never',
        },
      },
    });
    await call('actual_get_schedules');
    assert(
      (await call('actual_get_id_by_name', {
        type: 'schedules',
        name: `MCP schedule ${suffix}`,
      })) === scheduleId,
      'Schedule name lookup failed',
    );
    await call('actual_update_schedule', {
      id: recurringScheduleId,
      fields: { amount: -5000, account: accountId, payee: payeeId },
    });
    await call('actual_delete_schedule', { scheduleId });
    await call('actual_delete_schedule', { scheduleId: recurringScheduleId });
    await call('actual_delete_payee', { id: payeeId });

    await call('actual_batch_budget_updates', {
      operations: [
        {
          method: 'setBudgetAmount',
          args: { month, categoryId: baseCategoryId, value: 23456 },
        },
        {
          method: 'setBudgetCarryover',
          args: { month, categoryId: baseCategoryId, flag: false },
        },
      ],
    });
    await call('actual_hold_budget_for_next_month', { month, amount: 100 });
    await call('actual_reset_budget_hold', { month });

    const query = await call('actual_q', { table: 'accounts' });
    query.selectExpressions = ['*'];
    const queriedAccounts = await call('actual_aql_query', { query });
    assert(
      Array.isArray(queriedAccounts.data),
      'AQL query did not return a data array',
    );
    await call('actual_run_query', { query });
    await call('actual_get_id_by_name', {
      type: 'accounts',
      name: `MCP updated checking ${suffix}`,
    });
    await call('actual_get_id_by_name', {
      type: 'categories',
      name: baseCategoryName,
    });
    await call('actual_delete_category', { id: baseCategoryId });
    await call('actual_delete_category_group', { id: baseGroupId });
    await call('actual_get_preferences');
    await call('actual_set_preference', {
      id: 'numberFormat',
      value: '1,234.5',
    });
    await call('actual_get_server_version');
    assert(
      (await call('actual_amount_to_integer', { amount: 12.34 })) === 1234,
      'amountToInteger returned an unexpected result',
    );
    assert(
      (await call('actual_integer_to_amount', { amount: 1234 })) === 12.34,
      'integerToAmount returned an unexpected result',
    );

    // Exercise export/import as a second local file, then remove that local
    // file and reload the server-backed test budget.
    const exported = await call('actual_export_budget');
    assert(exported.byteLength > 0 && exported.data, 'Budget export was empty');
    importedBudget = await call('actual_import_budget', {
      source: exported.data,
      sourceType: 'base64',
      filename: 'mcp-e2e-export.zip',
      type: 'actual',
    });
    assert(importedBudget.id, 'Budget import did not return a local id');
    await call('actual_get_accounts');
    await removeBudget(call, importedBudget);
    importedBudget = null;
    await call('actual_download_budget', {
      syncId: createdBudget.groupId,
      useEncryptionPassword: true,
    });
    await call('actual_sync');

    console.log('MCP API end-to-end operations passed.');
  } finally {
    if (call) {
      if (importedBudget) {
        await removeBudget(call, importedBudget);
      }

      if (!helperBudget && helperBudgetName) {
        try {
          const budgets = await call('actual_get_budgets');
          helperBudget = findBudget(budgets, helperBudgetName);
        } catch {}
      }
      if (helperBudget) {
        await removeBudget(call, helperBudget);
      }

      if (!createdBudget && createdBudgetName) {
        try {
          const budgets = await call('actual_get_budgets');
          createdBudget = findBudget(budgets, createdBudgetName);
        } catch {}
      }
      if (createdBudget) {
        await removeBudget(call, createdBudget);
        let removed = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const remaining = await call('actual_get_budgets');
            const residual = findBudget(remaining, createdBudgetName);
            if (!residual) {
              removed = true;
              break;
            }
            await safeCall(call, 'actual_delete_budget_file', {
              cloudFileId: residual.cloudFileId,
            });
          } catch {
            break;
          }
        }
        if (!removed) {
          throw new Error(`Could not confirm removal of ${createdBudgetName}`);
        }
        console.log(`Removed server budget: ${createdBudgetName}`);
      }

      await safeCall(call, 'actual_shutdown');
    }
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (shouldRemoveDataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
