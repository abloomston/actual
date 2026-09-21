import type {
  CategorizationPlugin,
  CategorizationTransaction,
} from '@actual-app/core/server/transactions/categorization-plugins';
import { OpenRouter } from '@openrouter/sdk';
import type { ChatRequest, ChatResult } from '@openrouter/sdk/models';
import type {
  CreateEmbeddingsRequest,
  CreateEmbeddingsResponse,
  CreateEmbeddingsResponseBody,
  SendChatCompletionRequestRequest,
  SendChatCompletionRequestResponse,
} from '@openrouter/sdk/models/operations';

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
};

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

function createSdkTransport(openRouter: OpenRouter): OpenRouterChatTransport {
  return async request => {
    const sdkRequest = {
      chatRequest: {
        ...request,
        provider: OPENROUTER_ZDR_PROVIDER_PREFERENCES,
        stream: false,
      },
    } satisfies SendChatCompletionRequestRequest;

    const response = await openRouter.chat.send(sdkRequest);
    if (!isChatResult(response)) {
      throw new Error('OpenRouter returned a streaming response unexpectedly');
    }

    return {
      choices: response.choices.map(choice => ({
        message: {
          content:
            typeof choice.message.content === 'string'
              ? choice.message.content
              : null,
          reasoning: choice.message.reasoning ?? null,
        },
      })),
    };
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
): OpenRouterEmbeddingTransport {
  return async request => {
    const sdkRequest = {
      requestBody: {
        ...request,
        provider: OPENROUTER_ZDR_PROVIDER_PREFERENCES,
      },
    } satisfies CreateEmbeddingsRequest;
    const response = await openRouter.embeddings.generate(sdkRequest);
    if (!isEmbeddingResult(response)) {
      throw new Error('OpenRouter returned an invalid embedding response');
    }

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
    options.transport ?? createSdkTransport(openRouter);
  const sendEmbedding =
    options.embeddingTransport ?? createSdkEmbeddingTransport(openRouter);

  return {
    id: options.id ?? 'actual-openrouter-base',
    enabled: options.enabled ?? true,
    needsCategorizedTransactions: false,
    openRouter,
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
