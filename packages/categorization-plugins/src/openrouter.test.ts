import type { CategorizationTransaction } from '@actual-app/core/server/transactions/categorization-plugins';
import { OpenRouter } from '@openrouter/sdk';
import type { ChatResult } from '@openrouter/sdk/models';
import type { CreateEmbeddingsResponseBody } from '@openrouter/sdk/models/operations';
import { describe, expect, it, vi } from 'vitest';

import { createOpenRouterPlugin } from './openrouter';
import type {
  OpenRouterChatRequest,
  OpenRouterChatTransport,
  OpenRouterEmbeddingRequest,
  OpenRouterEmbeddingTransport,
} from './openrouter';

const transaction = {
  id: 'transaction-id',
  account: 'account-id',
  date: '2026-01-01',
  amount: -100,
} satisfies CategorizationTransaction;

describe('createOpenRouterPlugin', () => {
  it('uses the Actual-specific environment variable by default', () => {
    const previousKey = process.env.ACTUAL__OPENROUTER_API_KEY;
    process.env.ACTUAL__OPENROUTER_API_KEY = 'environment-key';

    try {
      const plugin = createOpenRouterPlugin();
      expect(plugin.openRouter._options.apiKey).toBe('environment-key');
    } finally {
      if (previousKey === undefined) {
        delete process.env.ACTUAL__OPENROUTER_API_KEY;
      } else {
        process.env.ACTUAL__OPENROUTER_API_KEY = previousKey;
      }
    }
  });

  it('does not fall back to the generic OpenRouter environment variable', () => {
    const previousActualKey = process.env.ACTUAL__OPENROUTER_API_KEY;
    const previousGenericKey = process.env.OPENROUTER_API_KEY;
    delete process.env.ACTUAL__OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'generic-key';

    try {
      const plugin = createOpenRouterPlugin();
      expect(plugin.openRouter._options.apiKey).toBe('');
    } finally {
      if (previousActualKey === undefined) {
        delete process.env.ACTUAL__OPENROUTER_API_KEY;
      } else {
        process.env.ACTUAL__OPENROUTER_API_KEY = previousActualKey;
      }
      if (previousGenericKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousGenericKey;
      }
    }
  });

  it('creates an OpenRouter client and declines categorization', async () => {
    const transport = vi.fn<OpenRouterChatTransport>();
    const plugin = createOpenRouterPlugin({
      apiKey: 'test-key',
      transport,
    });

    expect(plugin.openRouter).toBeInstanceOf(OpenRouter);
    await expect(plugin.categorize(transaction, [])).resolves.toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it('forces ZDR on SDK chat and embedding requests', async () => {
    const plugin = createOpenRouterPlugin({ apiKey: 'test-key' });
    const chatResponse = {
      choices: [
        {
          finishReason: 'stop',
          index: 0,
          message: { content: 'ok', role: 'assistant' },
        },
      ],
      created: 0,
      id: 'chat-id',
      model: 'test/model',
      object: 'chat.completion',
      systemFingerprint: null,
    } satisfies ChatResult;
    const embeddingResponse = {
      data: [{ embedding: [0.1, 0.2], index: 0, object: 'embedding' }],
      model: 'openai/text-embedding-3-small',
      object: 'list',
    } satisfies CreateEmbeddingsResponseBody;
    const chatSend = vi
      .spyOn(plugin.openRouter.chat, 'send')
      .mockResolvedValue(chatResponse);
    const embeddingGenerate = vi
      .spyOn(plugin.openRouter.embeddings, 'generate')
      .mockResolvedValue(embeddingResponse);

    await plugin.sendChatCompletion({ model: 'test/model', messages: [] });
    await plugin.sendEmbedding({
      model: 'openai/text-embedding-3-small',
      input: 'transaction text',
    });

    expect(chatSend).toHaveBeenCalledWith({
      chatRequest: expect.objectContaining({
        provider: { zdr: true },
        stream: false,
      }),
    });
    expect(embeddingGenerate).toHaveBeenCalledWith({
      requestBody: expect.objectContaining({ provider: { zdr: true } }),
    });
  });

  it('exposes a testable embedding transport', async () => {
    const embeddingTransport = vi.fn<OpenRouterEmbeddingTransport>(
      async request => ({
        data: [{ embedding: [0.1, 0.2] }],
        model: request.model,
      }),
    );
    const plugin = createOpenRouterPlugin({ embeddingTransport });
    const request: OpenRouterEmbeddingRequest = {
      model: 'openai/text-embedding-3-small',
      input: 'transaction text',
    };

    await expect(plugin.sendEmbedding(request)).resolves.toEqual({
      data: [{ embedding: [0.1, 0.2] }],
      model: request.model,
    });
    expect(embeddingTransport).toHaveBeenCalledWith(request);
  });

  it('exposes a testable chat-completion transport', async () => {
    const transport = vi.fn<OpenRouterChatTransport>(async _request => ({
      choices: [
        {
          message: {
            content: JSON.stringify({ ok: true }),
          },
        },
      ],
    }));
    const plugin = createOpenRouterPlugin({ transport });
    const messages: OpenRouterChatRequest['messages'] = [
      { role: 'user', content: 'hello' },
    ];

    const response = await plugin.sendChatCompletion({
      model: 'test/model',
      messages,
    });

    expect(response.choices[0]?.message.content).toContain('ok');
    expect(transport).toHaveBeenCalledWith({
      model: 'test/model',
      messages,
    });
  });
});
