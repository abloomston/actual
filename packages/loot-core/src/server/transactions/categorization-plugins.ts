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
    }
  | null
  | undefined;

export type CategorizationPlugin = {
  /** A stable identifier used to manage the plugin. */
  id: string;
  /** Disabled plugins remain registered but are not called. */
  enabled?: boolean;
  categorize: (
    transaction: CategorizationTransaction,
    categorizedTransactions: readonly CategorizationTransaction[],
  ) => CategorizationPluginResult | Promise<CategorizationPluginResult>;
};

export type CategorizationCandidate = {
  category: string;
  confidence: number;
  pluginId: string;
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
    !isValidConfidence(result.confidence)
  ) {
    logger.warn(
      `Categorization plugin "${plugin.id}" returned an invalid result`,
    );
    return null;
  }

  return {
    category: result.category,
    confidence: result.confidence,
    pluginId: plugin.id,
  };
}

/**
 * Run all enabled plugins and select the highest-confidence prediction.
 *
 * Plugins are evaluated independently. A plugin error or malformed response
 * is logged and ignored so one optional plugin cannot prevent transactions
 * from being imported. Ties are resolved in registration order, which makes
 * the result deterministic without giving any plugin an implicit priority.
 */
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

  const history =
    categorizedTransactions ??
    (await getCategorizedTransactions(transaction.id));

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
    if (
      candidate &&
      (bestCandidate == null || candidate.confidence > bestCandidate.confidence)
    ) {
      bestCandidate = candidate;
    }
  }

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
