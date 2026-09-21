import { join } from 'node:path';

import {
  createEmbeddingLlmJudgePlugin,
  createEmbeddingPlugin,
  createLlmJudgePlugin,
  createOpenRouterPlugin,
} from '@actual-app/categorization-plugins';
import type { CategorizationCategory } from '@actual-app/categorization-plugins';

import {
  registerCategorizationPlugin,
  setCategorizationPluginEnabled,
} from './categorization';

export const DEFAULT_CATEGORIZATION_PLUGIN_ID =
  'actual-default-embedding-llm-judge';

export type DefaultCategorizationPluginOptions = {
  budgetId: string;
  dataDir: string;
  categories: () => Promise<readonly CategorizationCategory[]>;
};

/**
 * Registers the default OpenRouter embedding/LLM categorization plugin for a
 * loaded Node API budget. The plugin is deliberately configured by the host
 * process rather than by loot-core so browser and sync-server builds do not
 * acquire Node-only vector storage or an OpenRouter dependency.
 */
export function registerDefaultCategorizationPlugin(
  options: DefaultCategorizationPluginOptions,
): (() => void) | null {
  if (!process.env.ACTUAL__OPENROUTER_API_KEY) {
    return null;
  }

  const base = createOpenRouterPlugin({
    id: `${DEFAULT_CATEGORIZATION_PLUGIN_ID}-base`,
  });
  const embedding = createEmbeddingPlugin({
    base,
    budgetKey: options.budgetId,
    indexPath: join(
      options.dataDir,
      '.actual-categorization-embeddings',
      options.budgetId,
    ),
  });
  const judge = createLlmJudgePlugin({
    base,
    categories: options.categories,
  });
  const plugin = createEmbeddingLlmJudgePlugin({
    embedding,
    judge,
    id: DEFAULT_CATEGORIZATION_PLUGIN_ID,
    enabled: true,
  });

  const unregister = registerCategorizationPlugin(plugin);
  setCategorizationPluginEnabled(plugin.id, true);
  return unregister;
}
