import type { CategorizationTransaction } from '@actual-app/core/server/transactions/categorization-plugins';
import { describe, expect, it, vi } from 'vitest';

import {
  createLlmJudgePlugin,
  createOpenRouterPlugin,
  DEFAULT_LLM_JUDGE_MODEL,
} from './index';
import type {
  CategorizationCategory,
  LlmJudgeReference,
  OpenRouterChatRequest,
  OpenRouterChatTransport,
} from './index';

const categories: CategorizationCategory[] = [
  { id: 'dining', name: 'Dining', group: 'Expenses' },
  { id: 'groceries', name: 'Groceries', group: 'Expenses' },
];

const transaction = {
  id: 'transaction-id',
  account: 'checking',
  date: '2026-01-01',
  amount: -4200,
  imported_payee: 'Coffee House',
  notes: 'Team breakfast',
  raw_synced_data: '{"merchant_type":"cafe"}',
} satisfies CategorizationTransaction;

const reference: LlmJudgeReference = {
  categoryId: 'dining',
  categoryName: 'Dining',
  similarity: 0.91,
  transaction: {
    id: 'reference-id',
    account: 'checking',
    date: '2025-12-01',
    amount: -3500,
    category: 'dining',
    imported_payee: 'Local Cafe',
  },
};

describe('LLM judge categorization plugin', () => {
  it('returns the model category, reasoning, and confidence', async () => {
    const transport = vi.fn<OpenRouterChatTransport>(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reasoning:
                'The payee and merchant data indicate a cafe purchase.',
              category: 'dining',
              confidence: 0.94,
            }),
          },
        },
      ],
    }));
    const base = createOpenRouterPlugin({ transport });
    const plugin = createLlmJudgePlugin({
      base,
      categories,
      promptCacheKey: 'budget-a-judge',
    });

    await expect(plugin.judgeTransaction(transaction)).resolves.toEqual({
      reasoning: 'The payee and merchant data indicate a cafe purchase.',
      category: 'dining',
      confidence: 0.94,
    });
    await expect(plugin.categorize(transaction, [])).resolves.toEqual({
      reasoning: 'The payee and merchant data indicate a cafe purchase.',
      category: 'dining',
      confidence: 0.94,
    });

    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('puts stable prompt content before changing examples and transaction data', async () => {
    let request: OpenRouterChatRequest | undefined;
    const transport = vi.fn<OpenRouterChatTransport>(async capturedRequest => {
      request = capturedRequest;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                reasoning: 'The examples support dining.',
                category: 'dining',
                confidence: 0.8,
              }),
            },
          },
        ],
      };
    });
    const base = createOpenRouterPlugin({ transport });
    const plugin = createLlmJudgePlugin({
      base,
      categories,
      promptCacheKey: 'budget-a-judge',
    });

    await plugin.judgeTransaction(transaction, [reference]);

    expect(DEFAULT_LLM_JUDGE_MODEL).toBe('google/gemini-2.5-flash-lite');
    expect(request?.model).toBe(DEFAULT_LLM_JUDGE_MODEL);
    expect(request?.promptCacheKey).toBe('budget-a-judge');
    expect(request?.provider).toEqual({ zdr: true });
    expect(request?.promptCacheOptions).toEqual({ mode: 'explicit' });
    expect(request?.responseFormat).toMatchObject({
      type: 'json_schema',
      jsonSchema: { name: 'transaction_categorization', strict: true },
    });

    const serializedMessages = JSON.stringify(request?.messages);
    expect(serializedMessages.indexOf('Category catalog')).toBeLessThan(
      serializedMessages.indexOf('Reference transactions'),
    );
    expect(serializedMessages.indexOf('Reference transactions')).toBeLessThan(
      serializedMessages.indexOf('Transaction to categorize'),
    );
    expect(serializedMessages).toContain('groceries');
    expect(serializedMessages).toContain('raw_synced_data');

    const systemMessage = request?.messages[0];
    expect(systemMessage?.role).toBe('system');
    expect(JSON.stringify(systemMessage)).toContain('promptCacheBreakpoint');
  });

  it('rejects a category ID that was not supplied in the catalog', async () => {
    const base = createOpenRouterPlugin({
      transport: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reasoning: 'Unknown category.',
                category: 'not-a-category',
                confidence: 1,
              }),
            },
          },
        ],
      }),
    });
    const plugin = createLlmJudgePlugin({ base, categories });

    await expect(plugin.judgeTransaction(transaction)).rejects.toThrow(
      'invalid categorization result',
    );
  });
});
