import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addTransactions } from '#server/accounts/sync';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import {
  clearCategorizationPlugins,
  getCategorizedTransactions,
  registerCategorizationPlugin,
  runCategorizationPlugins,
  setCategorizationPluginEnabled,
} from '#server/transactions/categorization-plugins';
import {
  insertRule,
  loadRules,
  runRules,
} from '#server/transactions/transaction-rules';

import type { CategorizationTransaction } from './categorization-plugins';

async function createTestData() {
  await db.insertAccount({ id: 'checking', name: 'Checking' });
  await db.insertCategoryGroup({ id: 'group', name: 'Expenses' });
  const groceries = await db.insertCategory({
    id: 'groceries',
    name: 'Groceries',
    cat_group: 'group',
  });
  const dining = await db.insertCategory({
    id: 'dining',
    name: 'Dining',
    cat_group: 'group',
  });
  return { groceries, dining };
}

function makeTransaction(overrides: Partial<CategorizationTransaction> = {}) {
  return {
    id: 'new-transaction',
    account: 'checking',
    date: '2024-01-15',
    amount: -1200,
    ...overrides,
  } satisfies CategorizationTransaction;
}

beforeEach(async () => {
  await global.emptyDatabase()();
  await loadMappings();
  await loadRules();
  clearCategorizationPlugins();
});

afterEach(() => {
  clearCategorizationPlugins();
});

describe('categorization plugins', () => {
  it('gives plugins all previously categorized transactions', async () => {
    const { groceries } = await createTestData();
    await db.insertTransaction({
      id: 'history',
      account: 'checking',
      date: '2024-01-01',
      amount: -500,
      category: groceries,
    });

    const categorize = vi.fn(
      async (
        transaction: CategorizationTransaction,
        categorizedTransactions: readonly CategorizationTransaction[],
      ) => {
        expect(transaction.id).toBe('new-transaction');
        expect(categorizedTransactions).toHaveLength(1);
        expect(categorizedTransactions[0].id).toBe('history');
        return { category: groceries, confidence: 0.75 };
      },
    );
    registerCategorizationPlugin({ id: 'history-plugin', categorize });

    const transaction = await runRules(makeTransaction());

    expect(transaction.category).toBe(groceries);
    expect(categorize).toHaveBeenCalledOnce();
    await expect(getCategorizedTransactions()).resolves.toEqual([
      expect.objectContaining({ id: 'history', category: groceries }),
    ]);
  });

  it('selects the highest-confidence enabled plugin and supports skipping', async () => {
    const transaction = makeTransaction();
    const lowConfidence = vi.fn(() => ({
      category: 'low',
      confidence: 0.2,
    }));
    const highConfidence = vi.fn(() => ({
      category: 'high',
      confidence: 0.9,
    }));
    const skipped = vi.fn(() => null);

    registerCategorizationPlugin({ id: 'low', categorize: lowConfidence });
    registerCategorizationPlugin({ id: 'high', categorize: highConfidence });
    registerCategorizationPlugin({ id: 'skipped', categorize: skipped });

    const result = await runCategorizationPlugins(transaction, {
      categorizedTransactions: [],
    });

    expect(result).toEqual({
      category: 'high',
      confidence: 0.9,
      pluginId: 'high',
    });
    expect(lowConfidence).toHaveBeenCalledOnce();
    expect(highConfidence).toHaveBeenCalledOnce();
    expect(skipped).toHaveBeenCalledOnce();

    setCategorizationPluginEnabled('high', false);
    const fallback = await runCategorizationPlugins(transaction, {
      categorizedTransactions: [],
    });
    expect(fallback).toEqual({
      category: 'low',
      confidence: 0.2,
      pluginId: 'low',
    });
  });

  it('logs plugin results and the winning candidate', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    registerCategorizationPlugin({
      id: 'low',
      categorize: () => ({ category: 'low', confidence: 0.2 }),
    });
    registerCategorizationPlugin({
      id: 'high',
      categorize: () => ({ category: 'high', confidence: 0.9 }),
    });

    try {
      await expect(
        runCategorizationPlugins(makeTransaction(), {
          categorizedTransactions: [],
        }),
      ).resolves.toEqual({
        category: 'high',
        confidence: 0.9,
        pluginId: 'high',
      });

      expect(log).toHaveBeenCalledWith(
        '[categorization] plugin-result',
        expect.objectContaining({
          transactionId: 'new-transaction',
          pluginId: 'low',
          category: 'low',
          confidence: 0.2,
        }),
      );
      expect(log).toHaveBeenCalledWith(
        '[categorization] plugin-result',
        expect.objectContaining({
          transactionId: 'new-transaction',
          pluginId: 'high',
          category: 'high',
          confidence: 0.9,
        }),
      );
      expect(log).toHaveBeenCalledWith(
        '[categorization] winner',
        expect.objectContaining({
          transactionId: 'new-transaction',
          pluginId: 'high',
          category: 'high',
          confidence: 0.9,
        }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('allows index-backed plugins to skip loading core transaction history', async () => {
    const { groceries } = await createTestData();
    await db.insertTransaction({
      id: 'history',
      account: 'checking',
      date: '2024-01-01',
      amount: -500,
      category: groceries,
    });

    let receivedHistory: readonly CategorizationTransaction[] | undefined;
    registerCategorizationPlugin({
      id: 'index-backed-plugin',
      needsCategorizedTransactions: false,
      categorize: (_transaction, categorizedTransactions) => {
        receivedHistory = categorizedTransactions;
        return null;
      },
    });

    await runCategorizationPlugins(makeTransaction());

    expect(receivedHistory).toEqual([]);
  });

  it('preserves optional plugin reasoning in the winning candidate', async () => {
    registerCategorizationPlugin({
      id: 'reasoning-plugin',
      categorize: () => ({
        category: 'groceries',
        confidence: 0.8,
        reasoning: 'The payee matches prior grocery transactions.',
      }),
    });

    await expect(
      runCategorizationPlugins(makeTransaction(), {
        categorizedTransactions: [],
      }),
    ).resolves.toEqual({
      category: 'groceries',
      confidence: 0.8,
      pluginId: 'reasoning-plugin',
      reasoning: 'The payee matches prior grocery transactions.',
    });
  });

  it('ignores malformed results and plugin failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const valid = vi.fn(() => ({ category: 'valid', confidence: 0 }));

    registerCategorizationPlugin({
      id: 'invalid-confidence',
      categorize: () => ({ category: 'invalid', confidence: 1.1 }),
    });
    registerCategorizationPlugin({
      id: 'throws',
      categorize: () => {
        throw new Error('plugin failed');
      },
    });
    registerCategorizationPlugin({ id: 'valid', categorize: valid });

    await expect(
      runCategorizationPlugins(makeTransaction(), {
        categorizedTransactions: [],
      }),
    ).resolves.toEqual({
      category: 'valid',
      confidence: 0,
      pluginId: 'valid',
    });

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('gives a rule-assigned category precedence over plugins', async () => {
    const { groceries, dining } = await createTestData();
    await insertRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Market' }],
      actions: [{ op: 'set', field: 'category', value: groceries }],
    });

    const categorize = vi.fn(() => ({ category: dining, confidence: 1 }));
    registerCategorizationPlugin({ id: 'competing-plugin', categorize });

    const transaction = await runRules(
      makeTransaction({ imported_payee: 'Market' }),
    );

    expect(transaction.category).toBe(groceries);
    expect(categorize).not.toHaveBeenCalled();
  });

  it('categorizes transactions added through the account import path', async () => {
    const { groceries } = await createTestData();
    await db.insertTransaction({
      id: 'history',
      account: 'checking',
      date: '2024-01-01',
      amount: -500,
      category: groceries,
    });

    registerCategorizationPlugin({
      id: 'import-plugin',
      categorize: async (_transaction, categorizedTransactions) => {
        return categorizedTransactions.some(t => t.id === 'history')
          ? { category: groceries, confidence: 0.8 }
          : null;
      },
    });

    const ids = await addTransactions('checking', [
      {
        date: '2024-01-15',
        amount: -1200,
        payee_name: 'Market',
      },
    ]);

    const id = ids?.[0];
    expect(id).toBeDefined();
    if (!id) {
      throw new Error('Expected an imported transaction id');
    }

    const transaction = await db.getTransaction(id);
    expect(transaction.category).toBe(groceries);
  });
});
