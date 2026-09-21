import type {
  CategorizationPluginResult,
  CategorizationTransaction,
} from '@actual-app/core/server/transactions/categorization-plugins';
import type { ChatRequest } from '@openrouter/sdk/models';

import type { CategorizationCategory } from './embedding';
import { OPENROUTER_ZDR_PROVIDER_PREFERENCES } from './openrouter';
import type { OpenRouterChatRequest, OpenRouterPlugin } from './openrouter';

export const DEFAULT_LLM_JUDGE_MODEL = 'google/gemini-2.5-flash-lite';

export type LlmJudgeReference = {
  categoryId: string;
  categoryName: string;
  similarity: number;
  transaction: CategorizationTransaction;
};

export type LlmJudgeResult = {
  reasoning: string;
  category: string | null;
  confidence: number;
};

export type LlmJudgeCategoriesSource =
  | readonly CategorizationCategory[]
  | (() =>
      | readonly CategorizationCategory[]
      | Promise<readonly CategorizationCategory[]>);

export type LlmJudgePlugin = OpenRouterPlugin & {
  readonly llmModel: string;
  getCategories(): Promise<readonly CategorizationCategory[]>;
  judgeTransaction(
    transaction: CategorizationTransaction,
    references?: readonly LlmJudgeReference[],
  ): Promise<LlmJudgeResult>;
};

export type LlmJudgePluginOptions = {
  base: OpenRouterPlugin;
  categories: LlmJudgeCategoriesSource;
  id?: string;
  enabled?: boolean;
  llmModel?: string;
  maxTokens?: number;
  promptCacheKey?: string;
  temperature?: number;
};

const judgeResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reasoning: {
      type: 'string',
      description: 'A concise explanation for the selected category.',
    },
    category: {
      type: ['string', 'null'],
      description: 'The selected category ID, or null when uncertain.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'A calibrated confidence score between 0 and 1.',
    },
  },
  required: ['reasoning', 'category', 'confidence'],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function resolveCategories(
  source: LlmJudgeCategoriesSource,
): Promise<CategorizationCategory[]> {
  const categories = typeof source === 'function' ? await source() : source;
  return [...categories].sort((a, b) => a.id.localeCompare(b.id));
}

function categoryCatalog(
  categories: readonly CategorizationCategory[],
): string {
  return categories.length === 0
    ? 'No categories are available. Return category as null.'
    : stableJson(categories);
}

const staticInstructions = [
  'You are a careful personal-finance transaction categorization judge.',
  'Choose exactly one category ID from the supplied category catalog, or null when the evidence is insufficient.',
  'Do not invent category IDs. Consider every supplied transaction field and any reference transactions.',
  'Return only the JSON object described by the response schema. Keep reasoning concise and factual.',
].join('\n');

/**
 * Builds messages with the stable instruction/category prefix first. Dynamic
 * reference examples come next, and the transaction being judged is last so
 * prompt caching can reuse the largest possible prefix between calls.
 */
export function buildLlmJudgeMessages(
  categories: readonly CategorizationCategory[],
  transaction: CategorizationTransaction,
  references: readonly LlmJudgeReference[] = [],
): OpenRouterChatRequest['messages'] {
  const staticPrefix = [
    staticInstructions,
    '',
    'Category catalog (the category field must contain one of these IDs):',
    categoryCatalog(categories),
  ].join('\n');
  const referencePrompt =
    references.length === 0
      ? 'No reference transactions were retrieved.'
      : `Reference transactions, grouped by their known category:\n${stableJson(references)}`;
  const transactionPrompt = `Transaction to categorize:\n${stableJson(transaction)}`;

  const messages = [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: staticPrefix,
          promptCacheBreakpoint: { mode: 'explicit' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: referencePrompt },
        { type: 'text', text: transactionPrompt },
      ],
    },
  ] satisfies ChatRequest['messages'];

  return messages;
}

function stripJsonCodeFence(content: string): string {
  const match = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? content.trim();
}

function parseJudgeResult(
  content: string,
  categories: readonly CategorizationCategory[],
): LlmJudgeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonCodeFence(content));
  } catch {
    throw new Error('LLM judge returned invalid JSON');
  }

  if (!isRecord(parsed)) {
    throw new Error('LLM judge returned a non-object result');
  }

  const reasoning = parsed.reasoning;
  const category = parsed.category;
  const confidence = parsed.confidence;
  const categoryIds = new Set(categories.map(item => item.id));

  if (
    typeof reasoning !== 'string' ||
    (category !== null &&
      (typeof category !== 'string' || !categoryIds.has(category))) ||
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error('LLM judge returned an invalid categorization result');
  }

  return { reasoning, category, confidence };
}

function createJudgeRequest(
  model: string,
  promptCacheKey: string,
  temperature: number,
  maxTokens: number,
  messages: OpenRouterChatRequest['messages'],
): OpenRouterChatRequest {
  return {
    model,
    messages,
    maxTokens,
    provider: OPENROUTER_ZDR_PROVIDER_PREFERENCES,
    promptCacheKey,
    promptCacheOptions: { mode: 'explicit' },
    responseFormat: {
      type: 'json_schema',
      jsonSchema: {
        name: 'transaction_categorization',
        description:
          'A category decision with concise reasoning and a confidence score.',
        strict: true,
        schema: judgeResponseSchema,
      },
    },
    temperature,
  };
}

/**
 * Adds an OpenRouter LLM-as-judge to the OpenRouter base plugin. The plugin
 * returns the model's reasoning as part of the categorization result so
 * callers can retain it for auditing even though Actual only persists the
 * category itself.
 */
export function createLlmJudgePlugin(
  options: LlmJudgePluginOptions,
): LlmJudgePlugin {
  const llmModel = options.llmModel ?? DEFAULT_LLM_JUDGE_MODEL;
  const promptCacheKey =
    options.promptCacheKey ?? `${options.base.id}-llm-judge`;
  const temperature = options.temperature ?? 0;
  const maxTokens = options.maxTokens ?? 800;

  async function judgeTransaction(
    transaction: CategorizationTransaction,
    references: readonly LlmJudgeReference[] = [],
  ): Promise<LlmJudgeResult> {
    const categories = await resolveCategories(options.categories);
    const response = await options.base.sendChatCompletion(
      createJudgeRequest(
        llmModel,
        promptCacheKey,
        temperature,
        maxTokens,
        buildLlmJudgeMessages(categories, transaction, references),
      ),
    );
    const content = response.choices[0]?.message.content;
    if (!content) {
      throw new Error('LLM judge returned no message content');
    }
    return parseJudgeResult(content, categories);
  }

  return {
    ...options.base,
    id: options.id ?? `${options.base.id}-llm-judge`,
    enabled: options.enabled ?? options.base.enabled ?? true,
    llmModel,
    getCategories: async () => resolveCategories(options.categories),
    judgeTransaction,
    async categorize(
      transaction,
      _categorizedTransactions,
    ): Promise<CategorizationPluginResult> {
      const result = await judgeTransaction(transaction);
      return {
        category: result.category,
        confidence: result.confidence,
        reasoning: result.reasoning,
      };
    },
  };
}
