import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CategorizationTransaction } from '@actual-app/core/server/transactions/categorization-plugins';
import { describe, expect, it, vi } from 'vitest';

import {
  createEmbeddingLlmJudgePlugin,
  createEmbeddingPlugin,
  createLlmJudgePlugin,
  createOpenRouterPlugin,
  DEFAULT_NEAREST_TRANSACTIONS_PER_CATEGORY,
} from './index';
import type {
  CategorizationCategory,
  OpenRouterChatRequest,
  OpenRouterChatTransport,
  OpenRouterEmbeddingTransport,
} from './index';

const categories: CategorizationCategory[] = [
  { id: 'dining', name: 'Dining', group: 'Expenses' },
  { id: 'groceries', name: 'Groceries', group: 'Expenses' },
];

function makeTransaction(
  id: string,
  category?: string,
): CategorizationTransaction {
  return {
    id,
    account: 'checking',
    date: '2026-01-01',
    amount: -100,
    category,
    notes: id,
  };
}

describe('embedding LLM judge categorization plugin', () => {
  it('supplies five closest transactions per category to the judge', async () => {
    const indexPath = await mkdtemp(join(tmpdir(), 'actual-embedding-judge-'));
    let request: OpenRouterChatRequest | undefined;
    const transport = vi.fn<OpenRouterChatTransport>(async capturedRequest => {
      request = capturedRequest;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                reasoning: 'The nearest labeled examples support groceries.',
                category: 'groceries',
                confidence: 0.93,
              }),
            },
          },
        ],
      };
    });
    const embed = vi.fn<OpenRouterEmbeddingTransport>(async ({ model }) => ({
      data: [{ embedding: [1, 0] }],
      model,
    }));
    const base = createOpenRouterPlugin({
      transport,
      embeddingTransport: embed,
    });
    const embedding = createEmbeddingPlugin({
      base,
      budgetKey: 'budget-a',
      indexPath,
    });
    const judge = createLlmJudgePlugin({ base, categories });
    const plugin = createEmbeddingLlmJudgePlugin({ embedding, judge });

    try {
      for (const category of categories) {
        for (let index = 0; index < 6; index++) {
          await plugin.indexTransaction(
            makeTransaction(`${category.id}-${index}`, category.id),
          );
        }
      }

      const result = await plugin.categorize(
        makeTransaction('new-transaction'),
        [],
      );

      expect(result).toEqual({
        reasoning: 'The nearest labeled examples support groceries.',
        category: 'groceries',
        confidence: 0.93,
      });
      expect(plugin.nearestTransactionsPerCategory).toBe(
        DEFAULT_NEAREST_TRANSACTIONS_PER_CATEGORY,
      );
      expect(transport).toHaveBeenCalledOnce();
      expect(request?.provider).toEqual({ zdr: true });

      const serializedMessages = JSON.stringify(request?.messages);
      expect([...serializedMessages.matchAll(/categoryId/g)]).toHaveLength(10);
      expect(serializedMessages).toContain('new-transaction');
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});
