import { afterEach, describe, expect, it } from 'vitest';

import {
  clearCategorizationPlugins,
  getCategorizationPlugins,
} from './categorization';
import {
  DEFAULT_CATEGORIZATION_PLUGIN_ID,
  registerDefaultCategorizationPlugin,
} from './categorization-default';

const originalApiKey = process.env.ACTUAL__OPENROUTER_API_KEY;

afterEach(() => {
  clearCategorizationPlugins();
  if (originalApiKey === undefined) {
    delete process.env.ACTUAL__OPENROUTER_API_KEY;
  } else {
    process.env.ACTUAL__OPENROUTER_API_KEY = originalApiKey;
  }
});

describe('default categorization plugin', () => {
  it('registers the enabled plugin when the API key is configured', () => {
    process.env.ACTUAL__OPENROUTER_API_KEY = 'test-key';

    const unregister = registerDefaultCategorizationPlugin({
      budgetId: 'budget-a',
      dataDir: '/tmp/actual-node-mcp',
      categories: async () => [],
    });

    expect(unregister).toEqual(expect.any(Function));
    expect(getCategorizationPlugins()).toEqual([
      expect.objectContaining({
        id: DEFAULT_CATEGORIZATION_PLUGIN_ID,
        enabled: true,
        embeddingModel: 'openai/text-embedding-3-small',
        llmModel: 'google/gemini-2.5-flash-lite',
      }),
    ]);

    unregister?.();
    expect(getCategorizationPlugins()).toEqual([]);
  });

  it('does not register when the API key is unavailable', () => {
    delete process.env.ACTUAL__OPENROUTER_API_KEY;

    expect(
      registerDefaultCategorizationPlugin({
        budgetId: 'budget-a',
        dataDir: '/tmp/actual-node-mcp',
        categories: async () => [],
      }),
    ).toBeNull();
    expect(getCategorizationPlugins()).toEqual([]);
  });
});
