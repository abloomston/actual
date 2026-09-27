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

  it('documents AQL query state, syntax, and the complete schema table list', () => {
    const query = TOOL_DEFINITIONS.find(
      tool => tool.name === 'actual_aql_query',
    );
    const description = query.description;

    for (const table of [
      'transactions',
      'accounts',
      'account_groups',
      'categories',
      'category_groups',
      'cleanup_groups',
      'payees',
      'schedules',
      'rules',
      'notes',
      'preferences',
      'transaction_filters',
      'custom_reports',
      'reflect_budgets',
      'zero_budgets',
      'dashboard_pages',
      'dashboard',
      'payee_locations',
    ]) {
      expect(description).toContain(table);
    }

    for (const detail of [
      'filterExpressions',
      'selectExpressions',
      'groupExpressions',
      '$and',
      '$or',
      '$oneof',
      '$transform',
      'tableOptions.splits',
    ]) {
      expect(description).toContain(detail);
    }
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

  it('exposes a two-transaction transfer-link tool', () => {
    const linkTransfer = TOOL_DEFINITIONS.find(
      tool => tool.name === 'actual_link_transactions_as_transfer',
    );

    expect(
      linkTransfer.inputSchema.safeParse({
        transactionIds: ['outgoing', 'incoming'],
      }).success,
    ).toBe(true);
    expect(
      linkTransfer.inputSchema.safeParse({ transactionIds: ['only-one'] })
        .success,
    ).toBe(false);
  });

  it('exposes validated single, list, account, and date-range categorization tools', () => {
    const toolNames = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
    for (const name of [
      'actual_categorize_transaction',
      'actual_categorize_transactions',
      'actual_categorize_uncategorized_transactions_for_account',
      'actual_categorize_uncategorized_transactions_for_date_range',
    ]) {
      expect(toolNames.has(name)).toBe(true);
    }

    const single = TOOL_DEFINITIONS.find(
      tool => tool.name === 'actual_categorize_transaction',
    );
    const list = TOOL_DEFINITIONS.find(
      tool => tool.name === 'actual_categorize_transactions',
    );
    const account = TOOL_DEFINITIONS.find(
      tool =>
        tool.name ===
        'actual_categorize_uncategorized_transactions_for_account',
    );
    const dateRange = TOOL_DEFINITIONS.find(
      tool =>
        tool.name ===
        'actual_categorize_uncategorized_transactions_for_date_range',
    );

    expect(
      single.inputSchema.safeParse({ transactionId: 'tx-1' }).success,
    ).toBe(true);
    expect(
      list.inputSchema.safeParse({ transactionIds: ['tx-1'] }).success,
    ).toBe(true);
    expect(list.inputSchema.safeParse({ transactionIds: [] }).success).toBe(
      false,
    );
    expect(
      account.inputSchema.safeParse({ accountId: 'account' }).success,
    ).toBe(true);
    expect(
      dateRange.inputSchema.safeParse({
        startDate: '2026-02-01',
        endDate: '2026-02-28',
      }).success,
    ).toBe(true);
    expect(
      dateRange.inputSchema.safeParse({
        startDate: '2026/02/01',
        endDate: '2026-02-28',
      }).success,
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
  function matchesFilter(transaction, filter) {
    return Object.entries(filter).every(([field, condition]) => {
      if (field === '$and') {
        return condition.every(item => matchesFilter(transaction, item));
      }
      if (field === '$or') {
        return condition.some(item => matchesFilter(transaction, item));
      }

      const value = transaction[field];
      const conditions = Array.isArray(condition) ? condition : [condition];
      return conditions.every(item => {
        if (item === null) return value == null;
        if (item && typeof item === 'object') {
          return Object.entries(item).every(([operator, expected]) => {
            if (operator === '$oneof') return expected.includes(value);
            if (operator === '$gte') return value >= expected;
            if (operator === '$lte') return value <= expected;
            if (operator === '$gt') return value > expected;
            if (operator === '$lt') return value < expected;
            return false;
          });
        }
        return value === item;
      });
    });
  }

  function makeApi({
    transactions = [],
    accounts = [{ id: 'account', offbudget: false }],
    payees = [],
    candidates = {},
    plugins = [{ id: 'actual-default-embedding-llm-judge', enabled: true }],
  } = {}) {
    const core = {
      send: vi.fn(async (name, args) => {
        if (name !== 'transactions-batch-update') {
          throw new Error(`Unexpected internal handler: ${name}`);
        }
        for (const transaction of args.updated) {
          const current = transactions.find(item => item.id === transaction.id);
          Object.assign(current, transaction);
        }
        return { updated: args.updated };
      }),
    };
    const api = {
      core,
      init: vi.fn(async () => core),
      shutdown: vi.fn(async () => undefined),
      getBudgets: vi.fn(async () => [{ name: 'Budget' }]),
      downloadBudget: vi.fn(async () => undefined),
      getAccounts: vi.fn(async () => accounts),
      getPayees: vi.fn(async () => payees),
      getCategorizationPlugins: vi.fn(() => plugins),
      runCategorizationPlugins: vi.fn(async transaction =>
        Object.hasOwn(candidates, transaction.id)
          ? candidates[transaction.id]
          : {
              category: 'suggested-category',
              confidence: 0.9,
              pluginId: 'actual-default-embedding-llm-judge',
            },
      ),
      updateTransaction: vi.fn(async (id, fields) => {
        const transaction = transactions.find(item => item.id === id);
        if (!transaction) throw new Error(`Unknown transaction: ${id}`);
        Object.assign(transaction, fields);
        return transaction;
      }),
      q: vi.fn(table => ({
        table,
        filterExpressions: [],
        tableOptions: {},
        selectExpressions: [],
        filter(expression) {
          this.filterExpressions.push(expression);
          return this;
        },
        options(options) {
          this.tableOptions = options;
          return this;
        },
        select(expressions) {
          this.selectExpressions = expressions;
          return this;
        },
      })),
      aqlQuery: vi.fn(async query => ({
        data: transactions.filter(transaction =>
          query.filterExpressions.every(filter =>
            matchesFilter(transaction, filter),
          ),
        ),
      })),
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
    return api;
  }

  async function makeInitializedSession(api) {
    const session = new ActualApiSession({
      api,
      ensureDir: vi.fn(async () => undefined),
      readSecret: vi.fn(async () => 'test-server-password'),
    });
    await session.executeTool('actual_init');
    return session;
  }

  it('links two valid transactions through one transfer-safe batch', async () => {
    const transactions = [
      {
        id: 'checking-out',
        account: 'checking',
        amount: -4058300,
        date: '2026-09-04',
        category: 'uncategorized',
        transfer_id: null,
      },
      {
        id: 'savings-in',
        account: 'savings',
        amount: 4058300,
        date: '2026-09-04',
        category: 'uncategorized',
        transfer_id: null,
      },
    ];
    const api = makeApi({
      transactions,
      payees: [
        { id: 'to-checking', transfer_acct: 'checking' },
        { id: 'to-savings', transfer_acct: 'savings' },
      ],
    });
    const session = await makeInitializedSession(api);

    const result = await session.executeTool(
      'actual_link_transactions_as_transfer',
      { transactionIds: ['checking-out', 'savings-in'] },
    );

    expect(api.core.send).toHaveBeenCalledTimes(1);
    expect(api.core.send).toHaveBeenCalledWith('transactions-batch-update', {
      updated: [
        expect.objectContaining({
          id: 'checking-out',
          category: null,
          payee: 'to-savings',
          transfer_id: 'savings-in',
        }),
        expect.objectContaining({
          id: 'savings-in',
          category: null,
          payee: 'to-checking',
          transfer_id: 'checking-out',
        }),
      ],
      runTransfers: false,
    });
    expect(result.linked).toBe(true);
    expect(transactions[0].transfer_id).toBe('savings-in');
    expect(transactions[1].transfer_id).toBe('checking-out');
  });

  it('rejects unsafe transfer pairs before sending a batch update', async () => {
    const transactions = [
      {
        id: 'one',
        account: 'checking',
        amount: -100,
        date: '2026-09-04',
        transfer_id: null,
      },
      {
        id: 'two',
        account: 'checking',
        amount: 100,
        date: '2026-09-04',
        transfer_id: null,
      },
    ];
    const api = makeApi({ transactions });
    const session = await makeInitializedSession(api);

    await expect(
      session.executeTool('actual_link_transactions_as_transfer', {
        transactionIds: ['one', 'two'],
      }),
    ).rejects.toThrow(/different accounts/);
    expect(api.core.send).not.toHaveBeenCalled();
  });

  it('refuses to link when either account lacks an unambiguous transfer payee', async () => {
    const transactions = [
      {
        id: 'one',
        account: 'checking',
        amount: -100,
        date: '2026-09-04',
        transfer_id: null,
      },
      {
        id: 'two',
        account: 'savings',
        amount: 100,
        date: '2026-09-04',
        transfer_id: null,
      },
    ];
    const api = makeApi({
      transactions,
      payees: [{ id: 'to-savings', transfer_acct: 'savings' }],
    });
    const session = await makeInitializedSession(api);

    await expect(
      session.executeTool('actual_link_transactions_as_transfer', {
        transactionIds: ['one', 'two'],
      }),
    ).rejects.toThrow(/exactly one transfer payee/);
    expect(api.core.send).not.toHaveBeenCalled();
  });

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

  it('uses ACTUAL_PASSWORD before querying the keyring', async () => {
    const api = makeApi();
    const serverCredential = ['server', 'credential', 'environment'].join('-');
    vi.stubEnv('ACTUAL_PASSWORD', serverCredential);
    const session = new ActualApiSession({
      api,
      ensureDir: vi.fn(async () => undefined),
      serverURL: 'http://localhost:5006',
      dataDir: '/tmp/actual-mcp-test',
    });

    try {
      await expect(session.executeTool('actual_get_budgets')).resolves.toEqual([
        { name: 'Budget' },
      ]);
      expect(api.init).toHaveBeenCalledWith({
        dataDir: '/tmp/actual-mcp-test',
        serverURL: 'http://localhost:5006',
        password: serverCredential,
      });
    } finally {
      await session.shutdown();
      vi.unstubAllEnvs();
    }
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

  it('recategorizes a specifically selected transaction even when it already has a category', async () => {
    const transaction = {
      id: 'tx-1',
      account: 'account',
      date: '2026-04-01',
      amount: -1200,
      category: 'old-category',
    };
    const api = makeApi({
      transactions: [transaction],
      candidates: {
        'tx-1': {
          category: 'new-category',
          confidence: 0.94,
          pluginId: 'actual-default-embedding-llm-judge',
          reasoning: 'The transaction matches this category.',
        },
      },
    });
    const session = await makeInitializedSession(api);

    const result = await session.executeTool('actual_categorize_transaction', {
      transactionId: 'tx-1',
    });

    expect(api.runCategorizationPlugins).toHaveBeenCalledWith(transaction);
    expect(api.updateTransaction).toHaveBeenCalledWith('tx-1', {
      category: 'new-category',
    });
    expect(transaction.category).toBe('new-category');
    expect(result).toMatchObject({
      total: 1,
      recategorized: 1,
      results: [
        {
          transactionId: 'tx-1',
          status: 'recategorized',
          previousCategory: 'old-category',
          category: 'new-category',
          confidence: 0.94,
        },
      ],
    });
  });

  it('categorizes a list, deduplicates IDs, and preserves the category when the plugin has no suggestion', async () => {
    const transactions = [
      {
        id: 'tx-1',
        account: 'account',
        date: '2026-04-01',
        amount: -1200,
        category: null,
      },
      {
        id: 'tx-2',
        account: 'account',
        date: '2026-04-02',
        amount: -2400,
        category: 'existing-category',
      },
    ];
    const api = makeApi({
      transactions,
      candidates: { 'tx-2': null },
    });
    const session = await makeInitializedSession(api);

    const result = await session.executeTool('actual_categorize_transactions', {
      transactionIds: ['tx-1', 'tx-2', 'tx-1'],
    });

    expect(api.runCategorizationPlugins).toHaveBeenCalledTimes(2);
    expect(api.updateTransaction).toHaveBeenCalledTimes(1);
    expect(api.updateTransaction).toHaveBeenCalledWith('tx-1', {
      category: 'suggested-category',
    });
    expect(result).toMatchObject({
      total: 2,
      categorized: 1,
      noSuggestion: 1,
      results: [
        { transactionId: 'tx-1', status: 'categorized' },
        {
          transactionId: 'tx-2',
          status: 'no-suggestion',
          previousCategory: 'existing-category',
          category: 'existing-category',
        },
      ],
    });
  });

  it('categorizes a batch with a rolling maximum of ten concurrent predictions', async () => {
    const transactions = Array.from({ length: 12 }, (_, index) => ({
      id: `tx-${index}`,
      account: 'account',
      date: `2026-04-${String(index + 1).padStart(2, '0')}`,
      amount: -100,
      category: null,
    }));
    const api = makeApi({ transactions });
    const startedIds = [];
    const completedIds = new Set();
    const releaseTransactions = new Map();
    const initiallyBlockedIds = new Set(
      transactions.slice(0, 10).map(transaction => transaction.id),
    );
    let active = 0;
    let maximumActive = 0;

    api.runCategorizationPlugins.mockImplementation(async transaction => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      startedIds.push(transaction.id);

      if (initiallyBlockedIds.has(transaction.id)) {
        await new Promise(resolve => {
          releaseTransactions.set(transaction.id, resolve);
        });
      }

      active -= 1;
      completedIds.add(transaction.id);
      return {
        category: `category-${transaction.id}`,
        confidence: 0.9,
        pluginId: 'actual-default-embedding-llm-judge',
      };
    });

    const session = await makeInitializedSession(api);
    const resultPromise = session.executeTool(
      'actual_categorize_transactions',
      {
        transactionIds: transactions.map(transaction => transaction.id),
      },
    );

    await vi.waitFor(() => {
      expect(startedIds).toHaveLength(10);
    });
    expect(active).toBe(10);
    expect(maximumActive).toBe(10);

    releaseTransactions.get('tx-0')?.();
    await vi.waitFor(() => {
      expect(startedIds).toHaveLength(transactions.length);
    });

    expect(completedIds.has('tx-0')).toBe(true);
    expect(completedIds.has('tx-1')).toBe(false);
    expect(completedIds.has('tx-10')).toBe(true);
    expect(completedIds.has('tx-11')).toBe(true);
    expect(api.updateTransaction).not.toHaveBeenCalled();

    for (const transaction of transactions.slice(1, 10)) {
      releaseTransactions.get(transaction.id)?.();
    }
    const result = await resultPromise;

    expect(maximumActive).toBe(10);
    expect(api.runCategorizationPlugins).toHaveBeenCalledTimes(12);
    expect(api.updateTransaction).toHaveBeenCalledTimes(12);
    expect(result).toMatchObject({ total: 12, categorized: 12 });
    expect(result.results.map(item => item.transactionId)).toEqual(
      transactions.map(transaction => transaction.id),
    );
  });

  it('categorizes only eligible uncategorized transactions for an account', async () => {
    const transactions = [
      {
        id: 'eligible',
        account: 'account',
        date: '2026-04-01',
        amount: -100,
        category: null,
      },
      {
        id: 'already-categorized',
        account: 'account',
        date: '2026-04-02',
        amount: -200,
        category: 'existing-category',
      },
      {
        id: 'split-parent',
        account: 'account',
        date: '2026-04-03',
        amount: -300,
        category: null,
        is_parent: true,
      },
      {
        id: 'transfer',
        account: 'account',
        date: '2026-04-04',
        amount: -400,
        category: null,
        transfer_id: 'other-transfer',
      },
      {
        id: 'other-account',
        account: 'other',
        date: '2026-04-05',
        amount: -500,
        category: null,
      },
    ];
    const api = makeApi({
      transactions,
      accounts: [
        { id: 'account', offbudget: false },
        { id: 'other', offbudget: false },
      ],
    });
    const session = await makeInitializedSession(api);

    const result = await session.executeTool(
      'actual_categorize_uncategorized_transactions_for_account',
      { accountId: 'account' },
    );

    expect(api.runCategorizationPlugins).toHaveBeenCalledTimes(1);
    expect(api.runCategorizationPlugins).toHaveBeenCalledWith(transactions[0]);
    expect(result).toMatchObject({
      total: 3,
      categorized: 1,
      skipped: 2,
      results: [
        { transactionId: 'eligible', status: 'categorized' },
        { transactionId: 'split-parent', status: 'skipped' },
        { transactionId: 'transfer', status: 'skipped' },
      ],
    });
  });

  it('categorizes uncategorized transactions within an inclusive date range across accounts', async () => {
    const transactions = [
      {
        id: 'start-date',
        account: 'account',
        date: '2026-04-01',
        amount: -100,
        category: null,
      },
      {
        id: 'end-date',
        account: 'other',
        date: '2026-04-30',
        amount: -200,
        category: null,
      },
      {
        id: 'too-early',
        account: 'account',
        date: '2026-03-31',
        amount: -300,
        category: null,
      },
      {
        id: 'too-late',
        account: 'account',
        date: '2026-05-01',
        amount: -400,
        category: null,
      },
      {
        id: 'off-budget',
        account: 'off-budget',
        date: '2026-04-15',
        amount: -500,
        category: null,
      },
    ];
    const api = makeApi({
      transactions,
      accounts: [
        { id: 'account', offbudget: false },
        { id: 'other', offbudget: false },
        { id: 'off-budget', offbudget: true },
      ],
    });
    const session = await makeInitializedSession(api);

    const result = await session.executeTool(
      'actual_categorize_uncategorized_transactions_for_date_range',
      { startDate: '2026-04-01', endDate: '2026-04-30' },
    );

    expect(api.runCategorizationPlugins).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      total: 3,
      categorized: 2,
      skipped: 1,
      results: [
        { transactionId: 'start-date', status: 'categorized' },
        { transactionId: 'end-date', status: 'categorized' },
        { transactionId: 'off-budget', status: 'skipped' },
      ],
    });
  });

  it('rejects invalid or reversed date ranges before querying transactions', async () => {
    const api = makeApi();
    const session = await makeInitializedSession(api);

    await expect(
      session.executeTool(
        'actual_categorize_uncategorized_transactions_for_date_range',
        { startDate: '2026-02-29', endDate: '2026-02-01' },
      ),
    ).rejects.toThrow('startDate and endDate must be valid calendar dates');
    expect(api.aqlQuery).not.toHaveBeenCalled();

    await expect(
      session.executeTool(
        'actual_categorize_uncategorized_transactions_for_date_range',
        { startDate: '2026-03-01', endDate: '2026-02-28' },
      ),
    ).rejects.toThrow('startDate must be on or before endDate');
    expect(api.aqlQuery).not.toHaveBeenCalled();
  });

  it('rejects categorization when no plugin is enabled', async () => {
    const transaction = {
      id: 'tx-1',
      account: 'account',
      date: '2026-04-01',
      amount: -1200,
      category: null,
    };
    const api = makeApi({ transactions: [transaction], plugins: [] });
    const session = await makeInitializedSession(api);

    await expect(
      session.executeTool('actual_categorize_transaction', {
        transactionId: 'tx-1',
      }),
    ).rejects.toThrow('No enabled categorization plugins are registered');
    expect(api.runCategorizationPlugins).not.toHaveBeenCalled();
  });
});
