import { init as initLootCore } from '@actual-app/core/server/main';
import type { InitConfig, lib } from '@actual-app/core/server/main';

import { getCategorizationCategories } from './categorization-categories';
import { registerDefaultCategorizationPlugin } from './categorization-default';
import type { DefaultCategorizationPluginOptions } from './categorization-default';
import { validateNodeVersion } from './validateNodeVersion';

export * from './methods';
export * from './categorization';
export * as utils from './utils';

/** @deprecated Please use return value of `init` instead */
export let internal: typeof lib | null = null;

let unregisterDefaultCategorizationPlugin: (() => void) | null = null;
let defaultCategorizationEnabled = false;

function registerDefaultPluginForBudget(budgetId: string): void {
  if (!defaultCategorizationEnabled) {
    return;
  }
  unregisterDefaultCategorizationPlugin?.();
  unregisterDefaultCategorizationPlugin = null;

  if (!internal) {
    return;
  }

  const options: DefaultCategorizationPluginOptions = {
    budgetId,
    dataDir: internal.getDataDir(),
    categories: getCategorizationCategories,
  };
  unregisterDefaultCategorizationPlugin =
    registerDefaultCategorizationPlugin(options);
}

export function enableDefaultCategorizationPlugin(): void {
  if (!internal) {
    throw new Error('The Actual API must be initialized first');
  }

  defaultCategorizationEnabled = true;
}

export function configureDefaultCategorizationPlugin(budgetId: string): void {
  registerDefaultPluginForBudget(budgetId);
}

export async function init(config: InitConfig = {}) {
  validateNodeVersion();

  unregisterDefaultCategorizationPlugin?.();
  unregisterDefaultCategorizationPlugin = null;
  defaultCategorizationEnabled = false;
  internal = await initLootCore(config);
  return internal;
}

export async function shutdown() {
  if (internal) {
    try {
      await internal.send('sync');
    } catch {
      // most likely that no budget is loaded, so the sync failed
    }

    unregisterDefaultCategorizationPlugin?.();
    unregisterDefaultCategorizationPlugin = null;
    defaultCategorizationEnabled = false;
    await internal.send('close-budget');
    internal = null;
  }
}
