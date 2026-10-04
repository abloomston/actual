import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TestProviders } from '#mocks';

import { useFormat } from './useFormat';

describe('useFormat compact currency', () => {
  it('rounds amounts to the nearest thousand and adds the compact suffix', () => {
    const { result } = renderHook(() => useFormat(), {
      wrapper: TestProviders,
    });

    expect(result.current.compactCurrency(523_456)).toBe('5k');
    expect(result.current.compactCurrency(550_000)).toBe('6k');
    expect(result.current.compactCurrency(-550_000)).toBe('-6k');
  });
});
