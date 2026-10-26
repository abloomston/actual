import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OPENROUTER_LOG_FILE_ENV_VAR } from '@actual-app/categorization-plugins';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearCategorizationPlugins,
  getCategorizationPlugins,
} from './categorization';
import {
  DEFAULT_CATEGORIZATION_PLUGIN_ID,
  registerDefaultCategorizationPlugin,
} from './categorization-default';

const originalApiKey = process.env.ACTUAL__OPENROUTER_API_KEY;
const originalLogFile = process.env[OPENROUTER_LOG_FILE_ENV_VAR];

let dir = '';
let logFile = '';

async function readLogEvents(): Promise<string[]> {
  const contents = await readFile(logFile, 'utf8');
  return contents
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as { event: string })
    .map(entry => entry.event);
}

describe('default categorization plugin', () => {
  beforeEach(async () => {
    // Keep the OpenRouter diagnostic log inside the test fixture instead of
    // the default /tmp file a real host would be reading.
    dir = await mkdtemp(join(tmpdir(), 'actual-api-categorization-'));
    logFile = join(dir, 'openrouter.log');
    process.env[OPENROUTER_LOG_FILE_ENV_VAR] = logFile;
  });

  afterEach(async () => {
    clearCategorizationPlugins();
    if (originalApiKey === undefined) {
      delete process.env.ACTUAL__OPENROUTER_API_KEY;
    } else {
      process.env.ACTUAL__OPENROUTER_API_KEY = originalApiKey;
    }
    if (originalLogFile === undefined) {
      delete process.env[OPENROUTER_LOG_FILE_ENV_VAR];
    } else {
      process.env[OPENROUTER_LOG_FILE_ENV_VAR] = originalLogFile;
    }
    await rm(dir, { recursive: true, force: true });
  });

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
        llmModel: 'google/gemini-3.5-flash-lite',
      }),
    ]);

    unregister?.();
    expect(getCategorizationPlugins()).toEqual([]);
  });

  it('logs the plugin it registers so calls can be traced', async () => {
    process.env.ACTUAL__OPENROUTER_API_KEY = 'test-key';

    registerDefaultCategorizationPlugin({
      budgetId: 'budget-a',
      dataDir: '/tmp/actual-node-mcp',
      categories: async () => [],
    });

    expect(await readLogEvents()).toEqual(['plugin.init']);
  });

  it('does not register when the API key is unavailable', async () => {
    delete process.env.ACTUAL__OPENROUTER_API_KEY;

    expect(
      registerDefaultCategorizationPlugin({
        budgetId: 'budget-a',
        dataDir: '/tmp/actual-node-mcp',
        categories: async () => [],
      }),
    ).toBeNull();
    expect(getCategorizationPlugins()).toEqual([]);

    // A host that ends up with no enabled plugins gets the reason in the log.
    const contents = await readFile(logFile, 'utf8');
    expect(contents).toContain('plugin.skipped');
    expect(JSON.parse(contents).level).toBe('warn');
    expect(JSON.parse(contents).reason).toBe(
      'ACTUAL__OPENROUTER_API_KEY is not set',
    );
  });
});
