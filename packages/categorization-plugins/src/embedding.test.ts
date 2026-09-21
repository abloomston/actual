import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CategorizationTransaction } from '@actual-app/core/server/transactions/categorization-plugins';
import { describe, expect, it, vi } from 'vitest';

import {
  createEmbeddingPlugin,
  createOpenRouterPlugin,
  serializeTransactionForEmbedding,
} from './index';
import type {
  CategorizationCategory,
  OpenRouterEmbeddingTransport,
} from './index';

function makeTransaction(
  overrides: Partial<CategorizationTransaction> = {},
): CategorizationTransaction {
  return {
    id: 'transaction-id',
    account: 'checking',
    date: '2026-01-01',
    amount: -100,
    ...overrides,
  };
}

describe('embedding categorization plugin', () => {
  it('removes category fields while retaining other transaction fields', () => {
    const serialized = serializeTransactionForEmbedding(
      makeTransaction({
        category: 'groceries',
        subtransactions: [
          {
            id: 'child',
            account: 'checking',
            date: '2026-01-01',
            amount: -100,
            category: 'dining',
          },
        ],
      }),
    );

    expect(serialized).not.toContain('groceries');
    expect(serialized).not.toContain('dining');
    expect(serialized).toContain('transaction-id');
    expect(serialized).toContain('child');
  });

  it('indexes transactions in Vectra and returns closest examples by category', async () => {
    const indexPath = await mkdtemp(join(tmpdir(), 'actual-embeddings-'));
    const embed = vi.fn<OpenRouterEmbeddingTransport>(
      async ({ input, model }) => ({
        data: [
          {
            embedding: input.includes('coffee') ? [1, 0] : [0, 1],
          },
        ],
        model,
      }),
    );
    const base = createOpenRouterPlugin({
      transport: async () => ({ choices: [] }),
      embeddingTransport: embed,
    });
    const plugin = createEmbeddingPlugin({
      base,
      budgetKey: 'budget-a',
      indexPath,
    });

    const categories: CategorizationCategory[] = [
      { id: 'groceries', name: 'Groceries' },
      { id: 'dining', name: 'Dining' },
    ];

    try {
      await plugin.indexTransaction(
        makeTransaction({
          id: 'groceries-transaction',
          category: 'groceries',
          notes: 'coffee beans',
        }),
      );
      await plugin.indexTransaction(
        makeTransaction({
          id: 'dining-transaction',
          category: 'dining',
          notes: 'restaurant dinner',
        }),
      );

      await expect(
        plugin.categorize(makeTransaction(), []),
      ).resolves.toBeNull();

      const matches = await plugin.queryClosestByCategory(
        makeTransaction({ notes: 'coffee shop' }),
        categories,
        1,
      );

      expect(matches.get('groceries')).toEqual([
        expect.objectContaining({
          category: 'groceries',
          id: 'groceries-transaction',
          transaction: expect.objectContaining({ notes: 'coffee beans' }),
        }),
      ]);
      expect(matches.get('dining')).toEqual([
        expect.objectContaining({
          category: 'dining',
          id: 'dining-transaction',
          score: 0,
        }),
      ]);
      expect(embed).toHaveBeenCalledWith({
        model: 'openai/text-embedding-3-small',
        input: expect.any(String),
        provider: { zdr: true },
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});
