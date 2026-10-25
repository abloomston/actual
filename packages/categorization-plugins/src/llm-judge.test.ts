import type { CategorizationTransaction } from '@actual-app/core/server/transactions/categorization-plugins';
import { OpenRouter } from '@openrouter/sdk';
import type { ChatResult } from '@openrouter/sdk/models';
import { describe, expect, it, vi } from 'vitest';

import {
  createLlmJudgePlugin,
  createOpenRouterPlugin,
  DEFAULT_LLM_JUDGE_MAX_TOKENS,
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
  {
    id: 'groceries',
    name: 'Groceries',
    group: 'Expenses',
    note: 'Food bought to prepare meals at home.',
  },
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

    expect(DEFAULT_LLM_JUDGE_MODEL).toBe('google/gemini-3.5-flash-lite');
    expect(DEFAULT_LLM_JUDGE_MAX_TOKENS).toBe(2000);
    expect(request?.model).toBe(DEFAULT_LLM_JUDGE_MODEL);
    expect(request?.maxTokens).toBe(DEFAULT_LLM_JUDGE_MAX_TOKENS);
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
    expect(serializedMessages).toContain(
      'Food bought to prepare meals at home.',
    );
    expect(serializedMessages).toContain('raw_synced_data');

    const systemMessage = request?.messages[0];
    expect(systemMessage?.role).toBe('system');
    expect(JSON.stringify(systemMessage)).toContain('promptCacheBreakpoint');
  });

  it('omits reasoning and temperature from the default judge request', async () => {
    let request: OpenRouterChatRequest | undefined;
    const transport = vi.fn<OpenRouterChatTransport>(async capturedRequest => {
      request = capturedRequest;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                reasoning: 'The payee matches a cafe.',
                category: 'dining',
                confidence: 0.9,
              }),
            },
          },
        ],
      };
    });
    const plugin = createLlmJudgePlugin({
      base: createOpenRouterPlugin({ transport }),
      categories,
    });

    await plugin.judgeTransaction(transaction);

    // The keys must be absent from the outgoing body, not serialized as null.
    expect(request).not.toHaveProperty('temperature');
    expect(request).not.toHaveProperty('reasoning');
    expect(Object.keys(request ?? {})).not.toContain('temperature');
    expect(Object.keys(request ?? {})).not.toContain('reasoning');
    expect(JSON.stringify(request)).not.toContain('"temperature"');
    // Gemini 3.x thinking is mandatory, and OpenRouter rejects effort "none",
    // so the judge must never ask for either.
    expect(JSON.stringify(request)).not.toContain('effort');
  });

  it('sends an explicit temperature and maxTokens override', async () => {
    let request: OpenRouterChatRequest | undefined;
    const transport = vi.fn<OpenRouterChatTransport>(async capturedRequest => {
      request = capturedRequest;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                reasoning: 'Groceries payee.',
                category: 'groceries',
                confidence: 0.85,
              }),
            },
          },
        ],
      };
    });
    const plugin = createLlmJudgePlugin({
      base: createOpenRouterPlugin({ transport }),
      categories,
      llmModel: 'openai/gpt-4.1-mini',
      maxTokens: 1200,
      temperature: 0,
    });

    await plugin.judgeTransaction(transaction);

    expect(request?.model).toBe('openai/gpt-4.1-mini');
    expect(request?.temperature).toBe(0);
    expect(request?.maxTokens).toBe(1200);
  });

  it('parses the verdict when the model returns thinking alongside content', async () => {
    const transport = vi.fn<OpenRouterChatTransport>(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reasoning: 'Reference transactions were also cafe purchases.',
              category: 'dining',
              confidence: 0.92,
            }),
            reasoning:
              'The payee is a coffee house and the amount is small, so this is dining out.',
          },
        },
      ],
    }));
    const plugin = createLlmJudgePlugin({
      base: createOpenRouterPlugin({ transport }),
      categories,
    });

    await expect(
      plugin.judgeTransaction(transaction, [reference]),
    ).resolves.toEqual({
      reasoning: 'Reference transactions were also cafe purchases.',
      category: 'dining',
      confidence: 0.92,
    });
    expect(plugin.llmModel).toBe(DEFAULT_LLM_JUDGE_MODEL);
  });

  it('fails clearly when thinking exhausts the completion budget', async () => {
    // This is what a Gemini 3.x response looks like when the whole
    // max_tokens budget is spent on reasoning: finish_reason "length" and
    // empty content, which the built-in transport maps to a null content.
    const openRouter = new OpenRouter({ apiKey: 'test-key' });
    const chatSend = vi.spyOn(openRouter.chat, 'send').mockResolvedValue({
      id: 'chat-completion-id',
      created: 0,
      model: DEFAULT_LLM_JUDGE_MODEL,
      object: 'chat.completion',
      systemFingerprint: null,
      choices: [
        {
          index: 0,
          finishReason: 'length',
          message: { role: 'assistant', content: '', reasoning: '...' },
        },
      ],
    } satisfies ChatResult);
    const plugin = createLlmJudgePlugin({
      base: createOpenRouterPlugin({ openRouter }),
      categories,
    });

    await expect(plugin.judgeTransaction(transaction)).rejects.toThrow(
      'LLM judge returned no message content',
    );
    await expect(plugin.categorize(transaction, [])).rejects.toThrow(
      'LLM judge returned no message content',
    );

    // The SDK transport is the last stop before the wire, so this is where the
    // omitted keys have to still be omitted.
    const sentRequest = chatSend.mock.calls[0]?.[0];
    expect(sentRequest?.chatRequest).toEqual(
      expect.objectContaining({
        model: DEFAULT_LLM_JUDGE_MODEL,
        maxTokens: DEFAULT_LLM_JUDGE_MAX_TOKENS,
        provider: { zdr: true },
      }),
    );
    expect(sentRequest?.chatRequest).not.toHaveProperty('temperature');
    expect(sentRequest?.chatRequest).not.toHaveProperty('reasoning');
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
