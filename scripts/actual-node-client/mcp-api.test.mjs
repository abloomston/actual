import { describe, expect, it, vi } from 'vitest';

import {
  ActualApiSession,
  API_METHOD_TO_TOOL,
  normalizeResult,
  TOOL_DEFINITIONS,
} from './mcp-api.mjs';

const expectedApiMethods = [
  'loadBudget',
  'downloadBudget',
  'getBudgets',
  'importBudget',
  'exportBudget',
  'sync',
  'runBankSync',
  'runImport',
  'batchBudgetUpdates',
  'runQuery',
  'aqlQuery',
  'q',
  'getBudgetMonths',
  'getBudgetMonth',
  'setBudgetAmount',
  'setBudgetCarryover',
  'addTransactions',
  'importTransactions',
  'getTransactions',
  'updateTransaction',
  'deleteTransaction',
  'mergeTransactions',
  'getAccounts',
  'createAccount',
  'updateAccount',
  'closeAccount',
  'reopenAccount',
  'deleteAccount',
  'getAccountBalance',
  'getAccountGroups',
  'createAccountGroup',
  'updateAccountGroup',
  'deleteAccountGroup',
  'getCategoryGroups',
  'createCategoryGroup',
  'updateCategoryGroup',
  'deleteCategoryGroup',
  'getCategories',
  'createCategory',
  'updateCategory',
  'deleteCategory',
  'getNote',
  'updateNote',
  'getCommonPayees',
  'getPayees',
  'createPayee',
  'updatePayee',
  'deletePayee',
  'getTags',
  'createTag',
  'updateTag',
  'deleteTag',
  'mergePayees',
  'getRules',
  'getPayeeRules',
  'createRule',
  'updateRule',
  'deleteRule',
  'holdBudgetForNextMonth',
  'resetBudgetHold',
  'createSchedule',
  'updateSchedule',
  'deleteSchedule',
  'getSchedules',
  'getIDByName',
  'getServerVersion',
  'getPreferences',
  'setPreference',
  'utils.amountToInteger',
  'utils.integerToAmount',
];

describe('Actual MCP tool catalog', () => {
  it('exposes every public @actual-app/api function', () => {
    expect(new Set(API_METHOD_TO_TOOL.keys())).toEqual(
      new Set(expectedApiMethods),
    );
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(expectedApiMethods.length);
    expect(new Set(TOOL_DEFINITIONS.map(tool => tool.name)).size).toBe(
      TOOL_DEFINITIONS.length,
    );
  });

  it('validates representative MCP inputs', () => {
    const init = TOOL_DEFINITIONS.find(tool => tool.name === 'actual_init');
    const transaction = TOOL_DEFINITIONS.find(
      tool => tool.name === 'actual_add_transactions',
    );
    const invalidMonth = TOOL_DEFINITIONS.find(
      tool => tool.name === 'actual_get_budget_month',
    );

    expect(
      init.inputSchema.safeParse({ serverURL: 'http://localhost:5006' })
        .success,
    ).toBe(true);
    expect(
      transaction.inputSchema.safeParse({
        accountId: 'account',
        transactions: [{ date: '2026-01-01', amount: 100 }],
      }).success,
    ).toBe(true);
    expect(
      invalidMonth.inputSchema.safeParse({ month: 'January' }).success,
    ).toBe(false);
  });
});

describe('normalizeResult', () => {
  it('makes API results JSON-safe without losing exported bytes', () => {
    const circular = {};
    circular.self = circular;
    const result = normalizeResult({
      date: new Date('2026-01-01T00:00:00.000Z'),
      integer: 123n,
      bytes: new Uint8Array([1, 2, 3]),
      circular,
    });

    expect(result).toEqual({
      date: '2026-01-01T00:00:00.000Z',
      integer: '123',
      bytes: { encoding: 'base64', byteLength: 3, data: 'AQID' },
      circular: { self: '[Circular]' },
    });
  });
});

describe('ActualApiSession', () => {
  function makeApi() {
    return {
      init: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      getBudgets: vi.fn(async () => [{ name: 'Budget' }]),
      downloadBudget: vi.fn(async () => undefined),
      getAccounts: vi.fn(async () => [{ id: 'account' }]),
      createAccount: vi.fn(async account => account.name),
      runImport: vi.fn(async (_name, callback) => callback()),
      batchBudgetUpdates: vi.fn(async callback => callback()),
      utils: {
        amountToInteger: vi.fn((amount, decimalPlaces = 2) =>
          Math.round(amount * 10 ** decimalPlaces),
        ),
        integerToAmount: vi.fn(
          (amount, decimalPlaces = 2) => amount / 10 ** decimalPlaces,
        ),
      },
    };
  }

  it('initializes from the injected keyring secret and serializes API calls', async () => {
    const api = makeApi();
    const serverCredential = ['server', 'credential', 'test'].join('-');
    const ensureDir = vi.fn(async () => undefined);
    const readSecret = vi.fn(async () => serverCredential);
    const session = new ActualApiSession({
      api,
      ensureDir,
      readSecret,
      serverURL: 'http://localhost:5006',
      dataDir: '/tmp/actual-mcp-test',
    });

    await expect(session.executeTool('actual_get_budgets')).resolves.toEqual([
      { name: 'Budget' },
    ]);
    expect(ensureDir).toHaveBeenCalledWith('/tmp/actual-mcp-test');
    expect(api.init).toHaveBeenCalledWith({
      dataDir: '/tmp/actual-mcp-test',
      serverURL: 'http://localhost:5006',
      password: serverCredential,
    });
    expect(readSecret).toHaveBeenCalledWith({
      serverURL: 'http://localhost:5006',
      kind: 'server-password',
    });

    await expect(
      session.executeTool('actual_create_account', {
        account: { name: 'checking' },
      }),
    ).resolves.toBe('checking');
    await session.executeTool('actual_shutdown');
    expect(api.shutdown).toHaveBeenCalledTimes(1);
  });

  it('downloads with the optional encryption secret and runs callback operations', async () => {
    const api = makeApi();
    const serverCredential = ['server', 'credential', 'test'].join('-');
    const encryptionCredential = ['encryption', 'credential', 'test'].join('-');
    const readSecret = vi.fn(async ({ kind }) =>
      kind === 'server-password' ? serverCredential : encryptionCredential,
    );
    const session = new ActualApiSession({
      api,
      ensureDir: vi.fn(async () => undefined),
      readSecret,
    });

    await session.executeTool('actual_init', { syncId: 'remote-id' });
    expect(api.downloadBudget).toHaveBeenCalledWith('remote-id', {
      password: encryptionCredential,
    });

    await session.executeTool('actual_run_import', {
      budgetName: 'callback-budget',
      operations: [
        {
          method: 'createAccount',
          args: { account: { name: 'inside-callback' } },
        },
      ],
    });
    expect(api.runImport).toHaveBeenCalledTimes(1);
    expect(api.createAccount).toHaveBeenCalledWith(
      { name: 'inside-callback' },
      undefined,
    );
  });

  it('fails before initialization when the keyring has no server password', async () => {
    const api = makeApi();
    const session = new ActualApiSession({
      api,
      ensureDir: vi.fn(async () => undefined),
      readSecret: vi.fn(async () => null),
    });

    await expect(session.executeTool('actual_get_accounts')).rejects.toThrow(
      /No server password was found in the keyring/,
    );
    expect(api.init).not.toHaveBeenCalled();
  });
});
