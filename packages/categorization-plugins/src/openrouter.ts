import type {
  CategorizationPlugin,
  CategorizationTransaction,
} from '@actual-app/core/server/transactions/categorization-plugins';
import { OpenRouter } from '@openrouter/sdk';
import type {
  ChatRequest,
  ChatResult,
  OpenRouterMetadata,
} from '@openrouter/sdk/models';
import type {
  CreateEmbeddingsRequest,
  CreateEmbeddingsResponse,
  CreateEmbeddingsResponseBody,
  SendChatCompletionRequestRequest,
  SendChatCompletionRequestResponse,
} from '@openrouter/sdk/models/operations';

import { createOpenRouterLogger } from './openrouter-log';
import type { OpenRouterLogFields, OpenRouterLogger } from './openrouter-log';

export type OpenRouterZdrProviderPreferences = {
  readonly zdr: true;
};

export const OPENROUTER_ZDR_PROVIDER_PREFERENCES = {
  zdr: true,
} satisfies OpenRouterZdrProviderPreferences;

export type OpenRouterChatRequest = Pick<
  ChatRequest,
  | 'messages'
  | 'maxTokens'
  | 'model'
  | 'promptCacheKey'
  | 'promptCacheOptions'
  | 'reasoning'
  | 'responseFormat'
  | 'temperature'
> & {
  model: string;
  provider?: OpenRouterZdrProviderPreferences;
};

export type OpenRouterChatResponse = {
  choices: Array<{
    message: {
      content?: string | null;
      reasoning?: string | null;
    };
  }>;
};

export type OpenRouterChatTransport = (
  request: OpenRouterChatRequest,
) => Promise<OpenRouterChatResponse>;

export type OpenRouterEmbeddingRequest = {
  model: string;
  input: string;
  dimensions?: number;
  provider?: OpenRouterZdrProviderPreferences;
  user?: string;
};

export type OpenRouterEmbeddingResponse = {
  data: Array<{
    embedding: number[];
    index?: number;
  }>;
  model?: string;
};

export type OpenRouterEmbeddingTransport = (
  request: OpenRouterEmbeddingRequest,
) => Promise<OpenRouterEmbeddingResponse>;

export type OpenRouterPlugin = CategorizationPlugin & {
  readonly openRouter: OpenRouter;
  readonly sendChatCompletion: OpenRouterChatTransport;
  readonly sendEmbedding: OpenRouterEmbeddingTransport;
  /**
   * Diagnostic logger for the OpenRouter calls made through this plugin. See
   * `openrouter-log.ts` for the default destination and its environment
   * overrides.
   */
  readonly log: OpenRouterLogger;
};

export type OpenRouterPluginOptions = {
  id?: string;
  enabled?: boolean;
  apiKey?: string;
  appCategories?: string;
  appTitle?: string;
  httpReferer?: string;
  serverURL?: string;
  timeoutMs?: number;
  openRouter?: OpenRouter;
  transport?: OpenRouterChatTransport;
  embeddingTransport?: OpenRouterEmbeddingTransport;
  /**
   * Diagnostic log path, or `false` to disable logging. Defaults to
   * `ACTUAL__OPENROUTER_LOG_FILE`, then `/tmp/actual-openrouter.log`.
   */
  logFile?: string | false;
  /**
   * Include request/response payloads in the log. Off by default because
   * prompts carry payees, notes and raw synced data.
   */
  logContent?: boolean;
  /** Reuse an existing logger instead of creating one from the options above. */
  logger?: OpenRouterLogger;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Character count of a message/tool payload without serializing it. Content is
 * only ever measured, never written to the log: the prompts carry transaction
 * data and stay out of a shared temp file unless content logging is on.
 */
function measureContent(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + measureContent(item), 0);
  }
  if (isRecord(value)) {
    return (
      measureContent(value.content) +
      measureContent(value.text) +
      measureContent(value.arguments)
    );
  }
  return 0;
}

function numberField(source: unknown, key: string): number | undefined {
  const value = isRecord(source) ? source[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Token usage, read structurally so a chat and an embedding response share one
 * shape and a missing detail simply drops out of the log line. Reasoning and
 * cache tokens are what make "the judge returned nothing" explicable: a
 * completion budget spent on thinking shows up here.
 */
function summarizeUsage(usage: unknown): OpenRouterLogFields {
  if (!isRecord(usage)) {
    return {};
  }
  return {
    usage: {
      promptTokens: numberField(usage, 'promptTokens'),
      completionTokens: numberField(usage, 'completionTokens'),
      totalTokens: numberField(usage, 'totalTokens'),
      cachedTokens: numberField(usage.promptTokensDetails, 'cachedTokens'),
      cacheWriteTokens: numberField(
        usage.promptTokensDetails,
        'cacheWriteTokens',
      ),
      reasoningTokens: numberField(
        usage.completionTokensDetails,
        'reasoningTokens',
      ),
      cost: numberField(usage, 'cost'),
    },
  };
}

/**
 * Routing metadata: which provider served the call and how many attempts the
 * router made. A ZDR-pinned request that found no eligible endpoint shows up
 * here (or in the paired `*.error` line), not in the category result.
 */
function summarizeRouting(
  metadata: OpenRouterMetadata | undefined,
): OpenRouterLogFields {
  if (!metadata) {
    return {};
  }
  return {
    routing: {
      attempt: metadata.attempt,
      attempts: metadata.attempts?.map(attempt => ({
        provider: attempt.provider,
        model: attempt.model,
        status: attempt.status,
      })),
      availableEndpoints: metadata.endpoints?.available?.map(
        endpoint => endpoint.provider,
      ),
      totalEndpoints: metadata.endpoints?.total,
      region: metadata.region,
      requested: metadata.requested,
      strategy: metadata.strategy,
    },
  };
}

function isChatResult(
  response: SendChatCompletionRequestResponse,
): response is ChatResult {
  return (
    typeof response === 'object' &&
    response !== null &&
    'choices' in response &&
    Array.isArray(response.choices)
  );
}

function createSdkTransport(
  openRouter: OpenRouter,
  log: OpenRouterLogger,
  pluginId: string,
): OpenRouterChatTransport {
  return async request => {
    const sdkRequest = {
      chatRequest: {
        ...request,
        provider: OPENROUTER_ZDR_PROVIDER_PREFERENCES,
        stream: false,
      },
    } satisfies SendChatCompletionRequestRequest;

    const call = log.start('chat', {
      pluginId,
      model: request.model,
      // The built-in transport pins ZDR on every call, so the log reports what
      // goes on the wire rather than what the caller happened to pass.
      zdr: sdkRequest.chatRequest.provider.zdr,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      responseFormatType: request.responseFormat?.type,
      reasoningEffort: request.reasoning?.effort,
      promptCacheKey: request.promptCacheKey,
      promptCacheMode: request.promptCacheOptions?.mode,
      messageCount: request.messages.length,
      promptChars: measureContent(request.messages),
      promptPreview: log.preview(request.messages),
    });

    let settled = false;
    const failureFields = {
      pluginId,
      model: request.model,
      zdr: sdkRequest.chatRequest.provider.zdr,
    };
    try {
      const response = await openRouter.chat.send(sdkRequest);
      if (!isChatResult(response)) {
        const error = new Error(
          'OpenRouter returned a streaming response unexpectedly',
        );
        settled = true;
        call.fail(error, {
          ...failureFields,
          unexpectedResponseType: typeof response,
        });
        throw error;
      }

      const choice = response.choices[0];
      settled = true;
      call.succeed({
        pluginId,
        model: request.model,
        responseId: response.id,
        responseModel: response.model,
        choiceCount: response.choices.length,
        finishReason: choice?.finishReason ?? null,
        contentChars: measureContent(choice?.message?.content),
        reasoningChars: measureContent(choice?.message?.reasoning),
        contentPreview: log.preview(choice?.message?.content),
        reasoningPreview: log.preview(choice?.message?.reasoning),
        ...summarizeUsage(response.usage),
        ...summarizeRouting(response.openrouterMetadata),
      });

      return {
        choices: response.choices.map(item => ({
          message: {
            content:
              typeof item.message.content === 'string'
                ? item.message.content
                : null,
            reasoning: item.message.reasoning ?? null,
          },
        })),
      };
    } catch (error) {
      if (!settled) {
        call.fail(error, failureFields);
      }
      throw error;
    }
  };
}

function isEmbeddingResult(
  response: CreateEmbeddingsResponse,
): response is CreateEmbeddingsResponseBody {
  return (
    typeof response === 'object' &&
    response !== null &&
    'data' in response &&
    Array.isArray(response.data)
  );
}

function createSdkEmbeddingTransport(
  openRouter: OpenRouter,
  log: OpenRouterLogger,
  pluginId: string,
): OpenRouterEmbeddingTransport {
  return async request => {
    const sdkRequest = {
      requestBody: {
        ...request,
        provider: OPENROUTER_ZDR_PROVIDER_PREFERENCES,
      },
    } satisfies CreateEmbeddingsRequest;

    const input: unknown = request.input;
    const call = log.start('embedding', {
      pluginId,
      model: request.model,
      zdr: sdkRequest.requestBody.provider.zdr,
      dimensions: request.dimensions,
      inputCount: Array.isArray(input) ? input.length : 1,
      inputChars: measureContent(input),
      inputPreview: log.preview(input),
    });

    let settled = false;
    const failureFields = {
      pluginId,
      model: request.model,
      zdr: sdkRequest.requestBody.provider.zdr,
    };
    try {
      const response = await openRouter.embeddings.generate(sdkRequest);
      if (!isEmbeddingResult(response)) {
        const error = new Error(
          'OpenRouter returned an invalid embedding response',
        );
        settled = true;
        call.fail(error, failureFields);
        throw error;
      }

      settled = true;
      const first = response.data[0];
      call.succeed({
        pluginId,
        model: request.model,
        responseModel: response.model,
        vectorCount: response.data.length,
        vectorDimensions:
          first && typeof first.embedding !== 'string'
            ? first.embedding.length
            : undefined,
        ...summarizeUsage(response.usage),
      });

      return {
        data: response.data.map(item => {
          if (typeof item.embedding === 'string') {
            throw new Error('OpenRouter returned a base64 embedding response');
          }
          return {
            embedding: item.embedding,
            index: item.index,
          };
        }),
        model: response.model,
      };
    } catch (error) {
      if (!settled) {
        call.fail(error, failureFields);
      }
      throw error;
    }
  };
}

/**
 * Creates the OpenRouter-backed base plugin used by the higher-level
 * categorization plugins.
 *
 * The base plugin deliberately declines every transaction. Its purpose is to
 * own the OpenRouter client and provide a testable chat-completion transport
 * to plugins built on top of it.
 */
export function createOpenRouterPlugin(
  options: OpenRouterPluginOptions = {},
): OpenRouterPlugin {
  const apiKey = options.apiKey ?? process.env.ACTUAL__OPENROUTER_API_KEY ?? '';
  const id = options.id ?? 'actual-openrouter-base';
  const log =
    options.logger ??
    createOpenRouterLogger({
      file: options.logFile,
      logContent: options.logContent,
    });
  const openRouter =
    options.openRouter ??
    new OpenRouter({
      apiKey,
      appCategories: options.appCategories,
      appTitle: options.appTitle,
      httpReferer: options.httpReferer,
      serverURL: options.serverURL,
      timeoutMs: options.timeoutMs,
    });
  const sendChatCompletion =
    options.transport ?? createSdkTransport(openRouter, log, id);
  const sendEmbedding =
    options.embeddingTransport ??
    createSdkEmbeddingTransport(openRouter, log, id);

  // One line per plugin construction so a host that never reaches OpenRouter
  // at all — no key, or a host-supplied transport — is still explainable from
  // the log alone.
  log.log(
    'plugin.init',
    {
      pluginId: id,
      logFile: log.file,
      logContent: log.logContent,
      hasApiKey: apiKey.length > 0,
      apiKeySource:
        options.apiKey !== undefined
          ? 'option'
          : process.env.ACTUAL__OPENROUTER_API_KEY
            ? 'env'
            : 'missing',
      chatTransport: options.transport ? 'custom' : 'openrouter-sdk',
      embeddingTransport: options.embeddingTransport
        ? 'custom'
        : 'openrouter-sdk',
      serverURL: options.serverURL,
      timeoutMs: options.timeoutMs,
      zdr: true,
      note:
        apiKey.length === 0
          ? 'ACTUAL__OPENROUTER_API_KEY is not set; OpenRouter requests will fail authentication'
          : undefined,
    },
    apiKey.length === 0 ? 'warn' : 'info',
  );

  return {
    id,
    enabled: options.enabled ?? true,
    needsCategorizedTransactions: false,
    openRouter,
    log,
    sendChatCompletion,
    sendEmbedding,
    async categorize(
      _transaction: CategorizationTransaction,
      _categorizedTransactions: readonly CategorizationTransaction[],
    ) {
      return null;
    },
  };
}
