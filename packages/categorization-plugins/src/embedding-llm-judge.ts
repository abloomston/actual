import type {
  CategorizationPluginResult,
  CategorizationTransaction,
} from '@actual-app/core/server/transactions/categorization-plugins';

import type { EmbeddingCategorizationPlugin } from './embedding';
import type { LlmJudgePlugin, LlmJudgeReference } from './llm-judge';

export const DEFAULT_NEAREST_TRANSACTIONS_PER_CATEGORY = 5;

export type EmbeddingLlmJudgePlugin = EmbeddingCategorizationPlugin &
  LlmJudgePlugin & {
    readonly nearestTransactionsPerCategory: number;
  };

export type EmbeddingLlmJudgePluginOptions = {
  embedding: EmbeddingCategorizationPlugin;
  judge: LlmJudgePlugin;
  id?: string;
  enabled?: boolean;
  nearestTransactionsPerCategory?: number;
};

/**
 * Composes the embedding index and the OpenRouter LLM judge. The embedding
 * layer retrieves the nearest labeled examples independently for every
 * category; the judge then sees those examples along with the full category
 * catalog and target transaction.
 */
export function createEmbeddingLlmJudgePlugin(
  options: EmbeddingLlmJudgePluginOptions,
): EmbeddingLlmJudgePlugin {
  const nearestTransactionsPerCategory =
    options.nearestTransactionsPerCategory ??
    DEFAULT_NEAREST_TRANSACTIONS_PER_CATEGORY;
  if (
    !Number.isInteger(nearestTransactionsPerCategory) ||
    nearestTransactionsPerCategory < 1
  ) {
    throw new Error(
      'nearestTransactionsPerCategory must be a positive integer',
    );
  }

  async function categorize(
    transaction: CategorizationTransaction,
    _categorizedTransactions: readonly CategorizationTransaction[],
  ): Promise<CategorizationPluginResult> {
    const categories = await options.judge.getCategories();
    const matchesByCategory = await options.embedding.queryClosestByCategory(
      transaction,
      categories,
      nearestTransactionsPerCategory,
    );
    const references: LlmJudgeReference[] = categories.flatMap(category =>
      (matchesByCategory.get(category.id) ?? []).map(match => ({
        categoryId: category.id,
        categoryName: category.name,
        similarity: match.score,
        transaction: match.transaction,
      })),
    );
    const result = await options.judge.judgeTransaction(
      transaction,
      references,
    );

    return {
      category: result.category,
      confidence: result.confidence,
      reasoning: result.reasoning,
    };
  }

  return {
    ...options.embedding,
    ...options.judge,
    id: options.id ?? `${options.embedding.id}-with-${options.judge.id}`,
    enabled:
      options.enabled ??
      ((options.embedding.enabled ?? true) && (options.judge.enabled ?? true)),
    nearestTransactionsPerCategory,
    categorize,
    async onTransactionCommitted(transaction) {
      if (transaction.category) {
        await options.embedding.indexTransaction(transaction);
      } else {
        await options.embedding.removeTransaction(transaction.id);
      }
    },
    onTransactionDeleted: transactionId =>
      options.embedding.removeTransaction(transactionId),
  };
}
