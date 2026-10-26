import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CategorizationTransaction } from '@actual-app/core/server/transactions/categorization-plugins';
import { OpenRouter } from '@openrouter/sdk';
import type { ChatResult } from '@openrouter/sdk/models';
import type {
  CreateEmbeddingsResponseBody,
  SendChatCompletionRequestResponse,
} from '@openrouter/sdk/models/operations';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenRouterPlugin } from './openrouter';
import type {
  OpenRouterChatRequest,
  OpenRouterChatTransport,
  OpenRouterEmbeddingRequest,
  OpenRouterEmbeddingTransport,
} from './openrouter';
import {
  DEFAULT_OPENROUTER_LOG_FILE,
  OPENROUTER_LOG_FILE_ENV_VAR,
} from './openrouter-log';
import type { OpenRouterLogEntry } from './openrouter-log';

// The option/Env wiring tests build real clients; keep their diagnostics out of
// the default /tmp log. The logging suite below points the logger at a fixture.
process.env[OPENROUTER_LOG_FILE_ENV_VAR] = 'off';

const transaction = {
  id: 'transaction-id',
  account: 'account-id',
  date: '2026-01-01',
  amount: -100,
} satisfies CategorizationTransaction;

async function readEntries(file: string): Promise<OpenRouterLogEntry[]> {
  const contents = await readFile(file, 'utf8');
  return contents
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as OpenRouterLogEntry);
}

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
    const plugin = createOpenRouterPlugin({
      apiKey: 'test-key',
      logFile: false,
    });
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

describe('OpenRouter call logging', () => {
  const judgeModel = 'google/gemini-3.5-flash-lite';
  const prompt = 'Coffee House - Team breakfast';

  let dir = '';
  let logFile = '';
  let previousLogFile: string | undefined;
  let previousApiKey: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'actual-openrouter-call-log-'));
    logFile = join(dir, 'calls.log');
    previousLogFile = process.env[OPENROUTER_LOG_FILE_ENV_VAR];
    previousApiKey = process.env.ACTUAL__OPENROUTER_API_KEY;
    // Proves the plugin honours the same override a host sets for the MCP server.
    process.env[OPENROUTER_LOG_FILE_ENV_VAR] = logFile;
    process.env.ACTUAL__OPENROUTER_API_KEY = 'environment-key';
  });

  afterEach(() => {
    if (previousLogFile === undefined) {
      delete process.env[OPENROUTER_LOG_FILE_ENV_VAR];
    } else {
      process.env[OPENROUTER_LOG_FILE_ENV_VAR] = previousLogFile;
    }
    if (previousApiKey === undefined) {
      delete process.env.ACTUAL__OPENROUTER_API_KEY;
    } else {
      process.env.ACTUAL__OPENROUTER_API_KEY = previousApiKey;
    }
  });

  function stubClient() {
    const openRouter = new OpenRouter({ apiKey: 'test-key' });
    const chatSend = vi.spyOn(openRouter.chat, 'send');
    const generate = vi.spyOn(openRouter.embeddings, 'generate');
    return { openRouter, chatSend, generate };
  }

  // A stand-in gateway on loopback, so the SDK itself is exercised: what the
  // log claims about HTTP statuses and response bodies has to be what the real
  // client hands back.
  async function startStubGateway(
    respond: (path: string, body: string) => { status: number; body: string },
  ) {
    const server = createServer((request, response) => {
      let payload = '';
      request.on('data', chunk => {
        payload += chunk;
      });
      request.on('end', () => {
        const result = respond(
          request.url ?? '',
          request.method === 'POST' ? payload : '',
        );
        response.writeHead(result.status, {
          'content-type': 'application/json',
        });
        response.end(result.body);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return {
      serverURL: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
  }

  function chatResult(content: string): ChatResult {
    return {
      choices: [
        {
          finishReason: 'stop',
          index: 0,
          message: {
            content,
            reasoning: 'thinking about the payee',
            role: 'assistant',
          },
        },
      ],
      created: 0,
      id: 'chat-completion-id',
      model: judgeModel,
      object: 'chat.completion',
      openrouterMetadata: {
        attempt: 1,
        attempts: [
          { model: judgeModel, provider: 'Google Vertex', status: 200 },
        ],
        endpoints: {
          available: [
            { model: judgeModel, provider: 'Google Vertex', selected: true },
          ],
          total: 5,
        },
        isByok: false,
        region: null,
        requested: judgeModel,
        strategy: 'auto',
        summary: '1 attempt(s)',
      },
      systemFingerprint: null,
      usage: {
        completionTokens: 300,
        completionTokensDetails: { reasoningTokens: 280 },
        cost: 0.0012,
        promptTokens: 1200,
        promptTokensDetails: { cacheWriteTokens: 200, cachedTokens: 1000 },
        totalTokens: 1500,
      },
    } satisfies ChatResult;
  }

  function judgeRequest(
    overrides: Partial<OpenRouterChatRequest> = {},
  ): OpenRouterChatRequest {
    return {
      maxTokens: 2000,
      messages: [{ content: prompt, role: 'user' }],
      model: judgeModel,
      promptCacheKey: 'budget-a-judge',
      promptCacheOptions: { mode: 'explicit' },
      provider: { zdr: true },
      responseFormat: {
        jsonSchema: {
          name: 'transaction_categorization',
          schema: { type: 'object' },
          strict: true,
        },
        type: 'json_schema',
      },
      ...overrides,
    };
  }

  it('logs a chat request and its response with usage and routing', async () => {
    const { openRouter, chatSend } = stubClient();
    chatSend.mockResolvedValue(
      chatResult('{"reasoning":"cafe","category":null,"confidence":0}'),
    );
    const plugin = createOpenRouterPlugin({
      apiKey: 'test-key',
      id: 'base',
      openRouter,
    });

    await plugin.sendChatCompletion(judgeRequest());

    const entries = await readEntries(logFile);
    const request = entries.find(entry => entry.event === 'chat.request');
    const response = entries.find(entry => entry.event === 'chat.response');

    expect(request).toMatchObject({
      callId: expect.any(String),
      level: 'info',
      model: judgeModel,
      pluginId: 'base',
      maxTokens: 2000,
      messageCount: 1,
      promptCacheKey: 'budget-a-judge',
      promptCacheMode: 'explicit',
      promptChars: prompt.length,
      responseFormatType: 'json_schema',
      zdr: true,
    });
    expect(request).not.toHaveProperty('promptPreview');

    expect(response?.callId).toBe(request?.callId);
    expect(typeof response?.durationMs).toBe('number');
    expect(response).toMatchObject({
      choiceCount: 1,
      contentChars: '{"reasoning":"cafe","category":null,"confidence":0}'
        .length,
      finishReason: 'stop',
      model: judgeModel,
      reasoningChars: 'thinking about the payee'.length,
      responseId: 'chat-completion-id',
      responseModel: judgeModel,
      usage: {
        cachedTokens: 1000,
        cacheWriteTokens: 200,
        completionTokens: 300,
        cost: 0.0012,
        promptTokens: 1200,
        reasoningTokens: 280,
        totalTokens: 1500,
      },
      routing: {
        attempt: 1,
        attempts: [
          { model: judgeModel, provider: 'Google Vertex', status: 200 },
        ],
        availableEndpoints: ['Google Vertex'],
        region: null,
        requested: judgeModel,
        strategy: 'auto',
        totalEndpoints: 5,
      },
    });
  });

  it('leaves prompt and response text out of the log by default', async () => {
    const { openRouter, chatSend } = stubClient();
    chatSend.mockResolvedValue(chatResult('the model answer'));
    const plugin = createOpenRouterPlugin({
      apiKey: 'test-key',
      openRouter,
    });
    expect(plugin.log.logContent).toBe(false);

    await plugin.sendChatCompletion(judgeRequest());

    const contents = await readFile(logFile, 'utf8');
    expect(contents).not.toContain(prompt);
    expect(contents).not.toContain('the model answer');
    expect(contents).not.toContain('thinking about the payee');
  });

  it('adds bounded payload previews when content logging is enabled', async () => {
    const { openRouter, chatSend } = stubClient();
    chatSend.mockResolvedValue(chatResult('the model answer'));
    const contentFile = join(dir, 'content.log');
    const plugin = createOpenRouterPlugin({
      apiKey: 'test-key',
      logContent: true,
      logFile: contentFile,
      openRouter,
    });

    await plugin.sendChatCompletion(judgeRequest());

    const entries = await readEntries(contentFile);
    expect(entries.find(entry => entry.event === 'chat.request')).toMatchObject(
      { promptPreview: expect.stringContaining(prompt) },
    );
    const response = entries.find(entry => entry.event === 'chat.response');
    expect(response).toMatchObject({
      contentPreview: expect.stringContaining('the model answer'),
      reasoningPreview: expect.stringContaining('thinking about the payee'),
    });

    // Long payloads are cut off rather than written out in full.
    await plugin.sendChatCompletion(
      judgeRequest({ messages: [{ content: 'y'.repeat(1200), role: 'user' }] }),
    );
    const preview = (await readEntries(contentFile)).filter(
      entry => entry.event === 'chat.request',
    )[1]?.promptPreview;
    expect(typeof preview === 'string' ? preview.length : 0).toBeLessThan(600);
    expect(String(preview)).toContain('[truncated');
  });

  it('logs the OpenRouter failure the caller would otherwise never see', async () => {
    const { openRouter, chatSend } = stubClient();
    chatSend.mockRejectedValue(
      Object.assign(new Error('No endpoints found matching your filters'), {
        statusCode: 404,
        body: '{"error":{"message":"no ZDR endpoint for this model"}}',
      }),
    );
    const plugin = createOpenRouterPlugin({
      apiKey: 'test-key',
      id: 'base',
      openRouter,
    });

    await expect(plugin.sendChatCompletion(judgeRequest())).rejects.toThrow(
      'No endpoints found',
    );

    const entries = await readEntries(logFile);
    const failure = entries.find(entry => entry.event === 'chat.error');
    expect(failure).toMatchObject({
      callId: entries.find(entry => entry.event === 'chat.request')?.callId,
      level: 'error',
      model: judgeModel,
      pluginId: 'base',
      zdr: true,
      error: {
        message: 'No endpoints found matching your filters',
        name: 'Error',
        responseBody: '{"error":{"message":"no ZDR endpoint for this model"}}',
        statusCode: 404,
      },
    });
  });

  it('logs an unexpected streaming response as a failure', async () => {
    const { openRouter, chatSend } = stubClient();
    // The transport forces `stream: false`; anything that is not a ChatResult
    // means the gateway answered with an event stream the judge cannot read.
    chatSend.mockResolvedValue({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
      }),
    } as unknown as SendChatCompletionRequestResponse);
    const plugin = createOpenRouterPlugin({
      apiKey: 'test-key',
      id: 'base',
      openRouter,
    });

    await expect(
      plugin.sendChatCompletion({ messages: [], model: judgeModel }),
    ).rejects.toThrow('streaming response unexpectedly');

    const entries = await readEntries(logFile);
    expect(entries.find(entry => entry.event === 'chat.error')).toMatchObject({
      level: 'error',
      pluginId: 'base',
      unexpectedResponseType: 'object',
    });
  });

  it('logs embedding calls without the vectors', async () => {
    const { openRouter, generate } = stubClient();
    generate.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3], index: 0, object: 'embedding' }],
      model: 'openai/text-embedding-3-small',
      object: 'list',
      usage: { promptTokens: 5, totalTokens: 5 },
    } satisfies CreateEmbeddingsResponseBody);
    const plugin = createOpenRouterPlugin({
      apiKey: 'test-key',
      id: 'base',
      openRouter,
    });

    await plugin.sendEmbedding({
      input: prompt,
      model: 'openai/text-embedding-3-small',
    });

    const entries = await readEntries(logFile);
    expect(
      entries.find(entry => entry.event === 'embedding.request'),
    ).toMatchObject({
      inputChars: prompt.length,
      inputCount: 1,
      model: 'openai/text-embedding-3-small',
      pluginId: 'base',
      zdr: true,
    });
    expect(
      entries.find(entry => entry.event === 'embedding.response'),
    ).toMatchObject({
      vectorCount: 1,
      vectorDimensions: 3,
      usage: { promptTokens: 5, totalTokens: 5 },
    });
    expect(await readFile(logFile, 'utf8')).not.toContain(prompt);
  });

  it('flags a missing embedding input or an invalid response', async () => {
    const { openRouter, generate } = stubClient();
    generate.mockResolvedValue('not an embedding body');
    const plugin = createOpenRouterPlugin({
      apiKey: 'test-key',
      id: 'base',
      openRouter,
    });

    await expect(
      plugin.sendEmbedding({ input: 'text', model: 'model' }),
    ).rejects.toThrow('invalid embedding response');

    const entries = await readEntries(logFile);
    expect(
      entries.find(entry => entry.event === 'embedding.error'),
    ).toMatchObject({
      level: 'error',
      pluginId: 'base',
      error: { message: 'OpenRouter returned an invalid embedding response' },
    });
  });

  it('records one init line per plugin, warning about a missing API key', async () => {
    delete process.env.ACTUAL__OPENROUTER_API_KEY;
    const plugin = createOpenRouterPlugin({ id: 'judge-base' });

    expect(plugin.log.file).toBe(logFile);
    expect(plugin.log.file).not.toBe(DEFAULT_OPENROUTER_LOG_FILE);

    const entries = await readEntries(logFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      apiKeySource: 'missing',
      chatTransport: 'openrouter-sdk',
      embeddingTransport: 'openrouter-sdk',
      event: 'plugin.init',
      hasApiKey: false,
      level: 'warn',
      logContent: false,
      logFile,
      note: expect.stringContaining('ACTUAL__OPENROUTER_API_KEY'),
      pluginId: 'judge-base',
      zdr: true,
    });

    // A host-supplied transport is labeled as such: the built-in diagnostics
    // cannot describe a request the plugin does not own.
    const customFile = join(dir, 'custom.log');
    createOpenRouterPlugin({
      apiKey: 'explicit-key',
      embeddingTransport: async () => ({ data: [] }),
      id: 'custom-base',
      logFile: customFile,
      transport: async () => ({ choices: [] }),
    });
    expect(await readEntries(customFile)).toMatchObject([
      {
        apiKeySource: 'option',
        chatTransport: 'custom',
        embeddingTransport: 'custom',
        event: 'plugin.init',
        hasApiKey: true,
        level: 'info',
        pluginId: 'custom-base',
      },
    ]);
  });

  it('logs a real HTTP round trip and the gateway rejection', async () => {
    let rejectNext = false;
    const gateway = await startStubGateway((path, payload) => {
      if (rejectNext) {
        return {
          status: 404,
          body: JSON.stringify({
            error: { message: 'no ZDR endpoint available for this model' },
          }),
        };
      }
      if (path.endsWith('/chat/completions')) {
        expect(JSON.parse(payload)).toMatchObject({
          model: judgeModel,
          provider: { zdr: true },
          stream: false,
        });
        return {
          status: 200,
          body: JSON.stringify({
            choices: [
              {
                finish_reason: 'length',
                index: 0,
                message: { content: '', role: 'assistant' },
              },
            ],
            created: 0,
            id: 'gen-1',
            model: judgeModel,
            object: 'chat.completion',
            system_fingerprint: null,
            usage: {
              completion_tokens: 800,
              completion_tokens_details: { reasoning_tokens: 800 },
              prompt_tokens: 1200,
              total_tokens: 2000,
            },
          }),
        };
      }
      return { status: 400, body: '{}' };
    });

    try {
      const plugin = createOpenRouterPlugin({
        apiKey: 'test-key',
        id: 'base',
        logFile,
        serverURL: gateway.serverURL,
      });

      const response = await plugin.sendChatCompletion(judgeRequest());
      expect(response.choices[0]?.message.content).toBe('');

      let entries = await readEntries(logFile);
      expect(
        entries.find(entry => entry.event === 'chat.request'),
      ).toMatchObject({
        maxTokens: 2000,
        messageCount: 1,
        model: judgeModel,
        promptChars: prompt.length,
        responseFormatType: 'json_schema',
        zdr: true,
      });
      expect(
        entries.find(entry => entry.event === 'chat.response'),
      ).toMatchObject({
        contentChars: 0,
        finishReason: 'length',
        model: judgeModel,
        usage: {
          completionTokens: 800,
          promptTokens: 1200,
          reasoningTokens: 800,
          totalTokens: 2000,
        },
      });
      expect(
        typeof entries.find(entry => entry.event === 'chat.response')
          ?.durationMs,
      ).toBe('number');

      rejectNext = true;
      await expect(
        plugin.sendChatCompletion(judgeRequest({ maxTokens: 90 })),
      ).rejects.toThrow();

      entries = await readEntries(logFile);
      expect(
        entries.filter(entry => entry.event === 'chat.request'),
      ).toHaveLength(2);
      expect(entries.find(entry => entry.event === 'chat.error')).toMatchObject(
        {
          level: 'error',
          pluginId: 'base',
          zdr: true,
          error: {
            responseBody: expect.stringContaining('no ZDR endpoint available'),
            statusCode: 404,
          },
        },
      );

      // Still no transaction content in the log, real wire included.
      expect(await readFile(logFile, 'utf8')).not.toContain(prompt);
    } finally {
      await gateway.close();
    }
  });

  it('writes nothing when a host disables logging', async () => {
    const { openRouter, chatSend } = stubClient();
    chatSend.mockResolvedValue(chatResult('ok'));
    const plugin = createOpenRouterPlugin({
      apiKey: 'test-key',
      logFile: false,
      openRouter,
    });

    await plugin.sendChatCompletion(judgeRequest());

    expect(plugin.log.enabled).toBe(false);
    await expect(readFile(logFile, 'utf8')).rejects.toThrow();
  });
});
