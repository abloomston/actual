import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { CategorizationTransaction } from '@actual-app/core/server/transactions/categorization-plugins';
import { LocalIndex } from 'vectra';
import type { MetadataFilter } from 'vectra';

import { OPENROUTER_ZDR_PROVIDER_PREFERENCES } from './openrouter';
import type {
  OpenRouterEmbeddingRequest,
  OpenRouterEmbeddingResponse,
  OpenRouterEmbeddingTransport,
  OpenRouterPlugin,
} from './openrouter';

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL =
  'openai/text-embedding-3-small';
export const DEFAULT_EMBEDDING_INDEX_PATH = join(
  process.cwd(),
  '.actual-categorization-embeddings',
);
// Increment when the embedding provider/model changes so old vector spaces
// cannot be compared with the current vectors.
export const EMBEDDING_VERSION = 2;

export type EmbeddingMetadata = {
  budgetKey: string;
  category: string;
  contentHash: string;
  embeddingModel: string;
  embeddingVersion: string;
  transactionId: string;
  transactionJson: string;
};

export type EmbeddingVectorStoreItem = {
  id: string;
  vector: number[];
  metadata: EmbeddingMetadata;
};

export type EmbeddingVectorStoreResult = {
  item: EmbeddingVectorStoreItem;
  score: number;
};

export type EmbeddingVectorStore = {
  ensure(): Promise<void>;
  upsert(item: EmbeddingVectorStoreItem): Promise<void>;
  delete(id: string): Promise<void>;
  query(
    vector: number[],
    topK: number,
    filter?: MetadataFilter,
  ): Promise<EmbeddingVectorStoreResult[]>;
};

export type CategorizationCategory = {
  id: string;
  name: string;
  group?: string;
};

export type EmbeddingMatch = {
  category: string;
  id: string;
  score: number;
  transaction: CategorizationTransaction;
};

export type EmbeddingCategorizationPlugin = OpenRouterPlugin & {
  readonly embeddingModel: string;
  readonly vectorStore: EmbeddingVectorStore;
  embedTransaction(transaction: CategorizationTransaction): Promise<number[]>;
  indexTransaction(transaction: CategorizationTransaction): Promise<void>;
  removeTransaction(transactionId: string): Promise<void>;
  queryClosestByCategory(
    transaction: CategorizationTransaction,
    categories: readonly CategorizationCategory[],
    perCategory: number,
  ): Promise<Map<string, EmbeddingMatch[]>>;
};

export type EmbeddingCategorizationPluginOptions = {
  base: OpenRouterPlugin;
  id?: string;
  enabled?: boolean;
  budgetKey?: string;
  embeddingModel?: string;
  embeddingTransport?: OpenRouterEmbeddingTransport;
  indexPath?: string;
  vectorStore?: EmbeddingVectorStore;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function removeCategories(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeCategories);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .filter(key => key !== 'category')
      .sort()
      .map(key => [key, removeCategories(value[key])]),
  );
}

/**
 * Serializes every transaction field except category into a deterministic
 * representation suitable for embedding and content-hash comparison.
 */
export function serializeTransactionForEmbedding(
  transaction: CategorizationTransaction,
): string {
  return JSON.stringify(removeCategories(transaction));
}

export function getTransactionEmbeddingContentHash(
  transaction: CategorizationTransaction,
): string {
  return createHash('sha256')
    .update(serializeTransactionForEmbedding(transaction))
    .digest('hex');
}

function isCategorizationTransaction(
  value: unknown,
): value is CategorizationTransaction {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.account === 'string' &&
    typeof value.date === 'string' &&
    typeof value.amount === 'number'
  );
}

function deserializeTransaction(
  value: string,
): CategorizationTransaction | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isCategorizationTransaction(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Creates a persistent vector store backed by the file-based Vectra package.
 * Full transaction JSON is stored as non-indexed metadata; filterable fields
 * remain in the index itself.
 */
export function createVectraEmbeddingVectorStore(
  folderPath: string,
): EmbeddingVectorStore {
  const index = new LocalIndex<EmbeddingMetadata>(folderPath);
  let ensurePromise: Promise<void> | undefined;

  async function ensure(): Promise<void> {
    ensurePromise ??= (async () => {
      if (!(await index.isIndexCreated())) {
        await index.createIndex({
          version: 1,
          metadata_config: {
            indexed: [
              'budgetKey',
              'category',
              'contentHash',
              'embeddingModel',
              'embeddingVersion',
              'transactionId',
            ],
          },
        });
      }
    })();
    await ensurePromise;
  }

  return {
    ensure,
    async upsert(item) {
      await ensure();
      await index.upsertItem(item);
    },
    async delete(id) {
      await ensure();
      await index.deleteItem(id);
    },
    async query(vector, topK, filter) {
      await ensure();
      const results = await index.queryItems<EmbeddingMetadata>(
        vector,
        '',
        topK,
        filter,
      );
      return results.map(result => ({
        item: {
          id: result.item.id,
          vector: result.item.vector,
          metadata: result.item.metadata,
        },
        score: result.score,
      }));
    },
  };
}

function metadataForTransaction(
  transaction: CategorizationTransaction,
  budgetKey: string,
  embeddingModel: string,
): EmbeddingMetadata {
  return {
    budgetKey,
    category: transaction.category ?? '',
    contentHash: getTransactionEmbeddingContentHash(transaction),
    embeddingModel,
    embeddingVersion: String(EMBEDDING_VERSION),
    transactionId: transaction.id,
    transactionJson: JSON.stringify(transaction),
  };
}

/**
 * Adds persistent OpenRouter/Vectra embedding capabilities to an OpenRouter base
 * plugin. Like the base plugin, this layer deliberately declines to
 * categorize transactions; it only exposes embedding, indexing, and nearest
 * neighbor operations for the final classifier plugin.
 */
export function createEmbeddingPlugin(
  options: EmbeddingCategorizationPluginOptions,
): EmbeddingCategorizationPlugin {
  const embeddingModel =
    options.embeddingModel ?? DEFAULT_OPENROUTER_EMBEDDING_MODEL;
  const budgetKey = options.budgetKey ?? 'default';
  const sendEmbedding =
    options.embeddingTransport ?? options.base.sendEmbedding;
  const vectorStore =
    options.vectorStore ??
    createVectraEmbeddingVectorStore(
      options.indexPath ?? DEFAULT_EMBEDDING_INDEX_PATH,
    );

  async function embedText(text: string): Promise<number[]> {
    const response: OpenRouterEmbeddingResponse = await sendEmbedding({
      model: embeddingModel,
      input: text,
      provider: OPENROUTER_ZDR_PROVIDER_PREFERENCES,
    } satisfies OpenRouterEmbeddingRequest);
    const vector = response.data[0]?.embedding;
    if (!vector || vector.length === 0) {
      throw new Error('OpenRouter returned no embedding vector');
    }
    return vector;
  }

  async function embedTransaction(
    transaction: CategorizationTransaction,
  ): Promise<number[]> {
    return embedText(serializeTransactionForEmbedding(transaction));
  }

  async function indexTransaction(
    transaction: CategorizationTransaction,
  ): Promise<void> {
    const vector = await embedTransaction(transaction);
    await vectorStore.upsert({
      id: transaction.id,
      vector,
      metadata: metadataForTransaction(transaction, budgetKey, embeddingModel),
    });
  }

  async function removeTransaction(transactionId: string): Promise<void> {
    await vectorStore.delete(transactionId);
  }

  async function queryClosestByCategory(
    transaction: CategorizationTransaction,
    categories: readonly CategorizationCategory[],
    perCategory: number,
  ): Promise<Map<string, EmbeddingMatch[]>> {
    if (!Number.isInteger(perCategory) || perCategory < 1) {
      throw new Error('perCategory must be a positive integer');
    }

    const vector = await embedTransaction(transaction);
    const matches = await Promise.all(
      categories.map(async category => {
        const results = await vectorStore.query(vector, perCategory + 1, {
          $and: [
            { budgetKey: { $eq: budgetKey } },
            { category: { $eq: category.id } },
            { embeddingModel: { $eq: embeddingModel } },
            { embeddingVersion: { $eq: String(EMBEDDING_VERSION) } },
          ],
        });

        const categoryMatches = results
          .filter(result => result.item.id !== transaction.id)
          .map(result => {
            const matchedTransaction = deserializeTransaction(
              result.item.metadata.transactionJson,
            );
            if (!matchedTransaction) {
              return null;
            }
            return {
              category: category.id,
              id: result.item.id,
              score: result.score,
              transaction: matchedTransaction,
            } satisfies EmbeddingMatch;
          })
          .filter((result): result is EmbeddingMatch => result !== null)
          .slice(0, perCategory);

        return [category.id, categoryMatches] as const;
      }),
    );

    return new Map(matches);
  }

  return {
    ...options.base,
    id: options.id ?? `${options.base.id}-embeddings`,
    enabled: options.enabled ?? options.base.enabled ?? true,
    embeddingModel,
    vectorStore,
    embedTransaction,
    indexTransaction,
    removeTransaction,
    queryClosestByCategory,
    async categorize() {
      return null;
    },
  };
}
