import type { PropsWithChildren } from 'react';

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createTestAppStore, TestProviders } from '#mocks';
import { setPrefs } from '#prefs/prefsSlice';

import { useAbbreviateAmounts } from './useAbbreviateAmounts';

function renderAbbreviationPreference(
  target: 'accounts' | 'budget',
  targets?: Array<'accounts' | 'budget'>,
) {
  const store = createTestAppStore();
  store.dispatch(
    setPrefs({ local: {}, global: { abbreviateAmounts: targets }, synced: {} }),
  );
  const wrapper = ({ children }: PropsWithChildren) => (
    <TestProviders store={store}>{children}</TestProviders>
  );

  return renderHook(() => useAbbreviateAmounts(target), { wrapper });
}

describe('useAbbreviateAmounts', () => {
  it('keeps account balances abbreviated by default for existing users', () => {
    expect(renderAbbreviationPreference('accounts').result.current).toBe(true);
    expect(renderAbbreviationPreference('budget').result.current).toBe(false);
  });

  it('abbreviates only the targets selected in preferences', () => {
    expect(
      renderAbbreviationPreference('accounts', ['budget']).result.current,
    ).toBe(false);
    expect(
      renderAbbreviationPreference('budget', ['budget']).result.current,
    ).toBe(true);
  });

  it('supports abbreviating both accounts and the budget view', () => {
    expect(
      renderAbbreviationPreference('accounts', ['accounts', 'budget']).result
        .current,
    ).toBe(true);
    expect(
      renderAbbreviationPreference('budget', ['accounts', 'budget']).result
        .current,
    ).toBe(true);
  });
});
