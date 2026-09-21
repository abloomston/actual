import { logger } from '#platform/server/log';
import * as db from '#server/db';
import type { TransactionEntity } from '#types/models';

/**
 * The result returned by a categorization plugin.
 *
 * Returning `null`/`undefined` (or a result with a null category) means that
 * the plugin declines to categorize the transaction. A confidence of zero is
 * still a valid prediction; it is different from declining to categorize.
 */
export type CategorizationTransaction = Omit<TransactionEntity, 'category'> & {
  category?: TransactionEntity['category'] | null;
};

export type CategorizationPluginResult =
  | {
      category: string | null;
      confidence: number;
      reasoning?: string;
    }
  | null
  | undefined;

export type CategorizationPlugin = {
  /** A stable identifier used to manage the plugin. */
  id: string;
  /** Disabled plugins remain registered but are not called. */
  enabled?: boolean;
  /** Set false when the plugin uses its own history/index lookup. */
  needsCategorizedTransactions?: boolean;
  categorize: (
    transaction: CategorizationTransaction,
    categorizedTransactions: readonly CategorizationTransaction[],
  ) => CategorizationPluginResult | Promise<CategorizationPluginResult>;
  /** Called after a transaction has been committed to the budget. */
  onTransactionCommitted?: (
    transaction: CategorizationTransaction,
  ) => void | Promise<void>;
  /** Called after a transaction has been deleted from the budget. */
  onTransactionDeleted?: (transactionId: string) => void | Promise<void>;
};

export type CategorizationCandidate = {
  category: string;
  confidence: number;
  pluginId: string;
  reasoning?: string;
};

type RegisteredCategorizationPlugin = CategorizationPlugin & {
  enabled: boolean;
};

export type CategorizationOptions = {
  categorizedTransactions?: readonly CategorizationTransaction[];
  /** True when a normal transaction rule has already assigned the category. */
  categorizedByRule?: boolean;
};

const plugins = new Map<string, RegisteredCategorizationPlugin>();

/**
 * Register a categorization plugin for the current core process.
 *
 * Plugins are intentionally runtime registrations rather than budget data:
 * plugin code is executable and must not be synchronized with a budget. A
 * registration remains active when budgets are switched, and receives the
 * categorized transactions from whichever budget is currently open.
 */
export function registerCategorizationPlugin(
  plugin: CategorizationPlugin,
): () => void {
  if (!plugin || typeof plugin !== 'object') {
    throw new Error('A categorization plugin is required');
  }
  if (typeof plugin.id !== 'string' || plugin.id.trim() === '') {
    throw new Error('A categorization plugin must have a non-empty id');
  }
  if (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean') {
    throw new Error(
      `Categorization plugin "${plugin.id}" must have a boolean enabled value`,
    );
  }
  if (typeof plugin.categorize !== 'function') {
    throw new Error(
      `Categorization plugin "${plugin.id}" must provide a categorize function`,
    );
  }
  if (plugins.has(plugin.id)) {
    throw new Error(
      `Categorization plugin "${plugin.id}" is already registered`,
    );
  }

  plugins.set(plugin.id, {
    ...plugin,
    enabled: plugin.enabled ?? true,
  });

  return () => {
    unregisterCategorizationPlugin(plugin.id);
  };
}

export function unregisterCategorizationPlugin(id: string): void {
  plugins.delete(id);
}

export function setCategorizationPluginEnabled(
  id: string,
  enabled: boolean,
): void {
  const plugin = plugins.get(id);
  if (!plugin) {
    throw new Error(`Categorization plugin "${id}" is not registered`);
  }

  plugin.enabled = enabled;
}

export function getCategorizationPlugins(): readonly CategorizationPlugin[] {
  return [...plugins.values()].map(plugin => ({ ...plugin }));
}

/**
 * Remove all registrations. This is primarily useful to reset an embedding
 * application's plugin registry, and for isolated tests.
 */
export function clearCategorizationPlugins(): void {
  plugins.clear();
}

/**
 * Return every currently stored transaction that already has a category.
 *
 * The target transaction is excluded when it has an id. This keeps a plugin
 * from using the transaction it is currently categorizing as its own history
 * when rules are manually re-run on an existing transaction.
 */
export async function getCategorizedTransactions(
  excludedTransactionId?: string,
): Promise<CategorizationTransaction[]> {
  const conditions = ['category IS NOT NULL', 'is_parent = 0'];
  const params: string[] = [];

  if (excludedTransactionId) {
    conditions.push('id != ?');
    params.push(excludedTransactionId);
  }

  const transactions: CategorizationTransaction[] = await db.selectWithSchema(
    'transactions',
    `SELECT * FROM v_transactions
     WHERE ${conditions.join(' AND ')}
     ORDER BY date DESC, sort_order DESC, id`,
    params,
  );

  return transactions;
}

function isValidConfidence(confidence: number): boolean {
  return (
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
  );
}

function normalizeCandidate(
  plugin: RegisteredCategorizationPlugin,
  result: CategorizationPluginResult,
): CategorizationCandidate | null {
  if (result == null || result.category == null) {
    return null;
  }

  if (
    typeof result.category !== 'string' ||
    result.category.trim() === '' ||
    !isValidConfidence(result.confidence) ||
    (result.reasoning !== undefined && typeof result.reasoning !== 'string')
  ) {
    logger.warn(
      `Categorization plugin "${plugin.id}" returned an invalid result`,
    );
    return null;
  }

  const candidate: CategorizationCandidate = {
    category: result.category,
    confidence: result.confidence,
    pluginId: plugin.id,
  };
  if (result.reasoning !== undefined) {
    candidate.reasoning = result.reasoning;
  }
  return candidate;
}

/**
 * Run all enabled plugins and select the highest-confidence prediction.
 *
 * Plugins are evaluated independently. A plugin error or malformed response
 * is logged and ignored so one optional plugin cannot prevent transactions
 * from being imported. Ties are resolved in registration order, which makes
 * the result deterministic without giving any plugin an implicit priority.
 */
export async function notifyCategorizationPluginChanges({
  added,
  updated,
  deletedIds,
}: {
  added: readonly CategorizationTransaction[];
  updated: readonly CategorizationTransaction[];
  deletedIds: readonly string[];
}): Promise<void> {
  const registeredPlugins = [...plugins.values()].filter(
    plugin => plugin.enabled,
  );

  for (const plugin of registeredPlugins) {
    try {
      if (plugin.onTransactionCommitted) {
        for (const transaction of [...added, ...updated]) {
          await plugin.onTransactionCommitted(transaction);
        }
      }
      if (plugin.onTransactionDeleted) {
        for (const transactionId of deletedIds) {
          await plugin.onTransactionDeleted(transactionId);
        }
      }
    } catch (error) {
      logger.warn(
        `Categorization plugin "${plugin.id}" failed to update its index`,
        error,
      );
    }
  }
}

export async function runCategorizationPlugins(
  transaction: CategorizationTransaction,
  {
    categorizedTransactions,
    categorizedByRule = false,
  }: CategorizationOptions = {},
): Promise<CategorizationCandidate | null> {
  if (categorizedByRule && transaction.category != null) {
    return null;
  }

  const enabledPlugins = [...plugins.values()].filter(plugin => plugin.enabled);
  if (enabledPlugins.length === 0) {
    return null;
  }

  const needsHistory = enabledPlugins.some(
    plugin => plugin.needsCategorizedTransactions !== false,
  );
  const history =
    categorizedTransactions ??
    (needsHistory ? await getCategorizedTransactions(transaction.id) : []);

  let bestCandidate: CategorizationCandidate | null = null;

  for (const plugin of enabledPlugins) {
    let result: CategorizationPluginResult;
    try {
      result = await plugin.categorize(transaction, history);
    } catch (error) {
      logger.warn(`Categorization plugin "${plugin.id}" failed`, error);
      continue;
    }

    const candidate = normalizeCandidate(plugin, result);
    logger.info('[categorization] plugin-result', {
      transactionId: transaction.id,
      pluginId: plugin.id,
      category: candidate?.category ?? null,
      confidence: candidate?.confidence ?? null,
    });
    if (
      candidate &&
      (bestCandidate == null || candidate.confidence > bestCandidate.confidence)
    ) {
      bestCandidate = candidate;
    }
  }

  logger.info('[categorization] winner', {
    transactionId: transaction.id,
    pluginId: bestCandidate?.pluginId ?? null,
    category: bestCandidate?.category ?? null,
    confidence: bestCandidate?.confidence ?? null,
  });

  return bestCandidate;
}

/**
 * Categorize a transaction with the highest-confidence enabled plugin.
 *
 * This function does not persist the transaction. Callers can use the
 * returned transaction as part of their existing transaction write path.
 */
export async function categorizeTransaction(
  transaction: TransactionEntity,
  options?: CategorizationOptions,
): Promise<TransactionEntity> {
  const candidate = await runCategorizationPlugins(transaction, options);
  return candidate
    ? { ...transaction, category: candidate.category }
    : transaction;
}
