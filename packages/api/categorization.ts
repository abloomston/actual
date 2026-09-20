export {
  categorizeTransaction,
  clearCategorizationPlugins,
  getCategorizationPlugins,
  getCategorizedTransactions,
  registerCategorizationPlugin,
  runCategorizationPlugins,
  setCategorizationPluginEnabled,
  unregisterCategorizationPlugin,
} from '@actual-app/core/server/transactions/categorization-plugins';
export type {
  CategorizationCandidate,
  CategorizationOptions,
  CategorizationPlugin,
  CategorizationTransaction,
  CategorizationPluginResult,
} from '@actual-app/core/server/transactions/categorization-plugins';
