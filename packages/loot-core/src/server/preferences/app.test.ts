import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as asyncStorage from '#platform/server/asyncStorage';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';

describe('global amount abbreviation preference', () => {
  const storage = new Map<string, unknown>();

  beforeEach(() => {
    storage.clear();
    storage.set('document-dir', '/test');
    vi.clearAllMocks();
    vi.mocked(asyncStorage.setItem).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(asyncStorage.multiGet).mockImplementation(async keys => {
      return Object.fromEntries(
        keys.map(key => [key, storage.get(key)]),
      ) as Awaited<ReturnType<typeof asyncStorage.multiGet>>;
    });
  });

  it('saves and loads the selected abbreviation targets', async () => {
    await runHandler(handlers['save-global-prefs'], {
      abbreviateAmounts: ['accounts', 'budget'],
    });

    const preferences = await runHandler(handlers['load-global-prefs']);

    expect(preferences.abbreviateAmounts).toEqual(['accounts', 'budget']);
  });

  it('preserves the legacy account-pane setting when loading preferences', async () => {
    storage.set('abbreviate-sidebar-balances', false);

    const preferences = await runHandler(handlers['load-global-prefs']);

    expect(preferences.abbreviateAmounts).toEqual([]);
  });

  it('defaults to abbreviating account balances for existing users', async () => {
    const preferences = await runHandler(handlers['load-global-prefs']);

    expect(preferences.abbreviateAmounts).toEqual(['accounts']);
  });

  it('defaults to hiding past budget months without transactions', async () => {
    const preferences = await runHandler(handlers['load-global-prefs']);

    expect(preferences.hideBudgetMonthsWithNoTransactions).toBe(true);
  });

  it('saves and loads the budget month visibility preference', async () => {
    await runHandler(handlers['save-global-prefs'], {
      hideBudgetMonthsWithNoTransactions: false,
    });

    const preferences = await runHandler(handlers['load-global-prefs']);

    expect(preferences.hideBudgetMonthsWithNoTransactions).toBe(false);
  });
});
