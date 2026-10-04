import { describe, expect, it } from 'vitest';

import { getVisibleBudgetMonths } from './MonthsContext';

describe('getVisibleBudgetMonths', () => {
  const months = ['2024-11', '2024-12', '2025-01', '2025-02', '2025-03'];
  const transactionMonths = new Set(['2024-11', '2025-02']);

  it('hides past months without transactions while retaining the current and future months', () => {
    expect(
      getVisibleBudgetMonths(months, transactionMonths, true, '2025-01'),
    ).toEqual(['2024-11', '2025-01', '2025-02', '2025-03']);
  });

  it('shows every month when hiding empty months is disabled', () => {
    expect(
      getVisibleBudgetMonths(months, transactionMonths, false, '2025-01'),
    ).toEqual(months);
  });

  it('does not hide months before the transaction query has loaded', () => {
    expect(getVisibleBudgetMonths(months, null, true, '2025-01')).toEqual(
      months,
    );
  });
});
