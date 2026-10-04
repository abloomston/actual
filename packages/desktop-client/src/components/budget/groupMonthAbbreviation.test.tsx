import React from 'react';

import { generateCategoryGroup } from '@actual-app/core/mocks';
import { render, screen } from '@testing-library/react';

import { useAbbreviateAmounts } from '#hooks/useAbbreviateAmounts';
import { useFormat } from '#hooks/useFormat';
import { useSheetValue } from '#hooks/useSheetValue';
import { TestProviders } from '#mocks';

import {
  ExpenseGroupMonth as EnvelopeExpenseGroupMonth,
  IncomeGroupMonth as EnvelopeIncomeGroupMonth,
} from './envelope/EnvelopeBudgetComponents';
import { GroupMonth as TrackingGroupMonth } from './tracking/TrackingBudgetComponents';

vi.mock('#hooks/useAbbreviateAmounts', () => ({
  useAbbreviateAmounts: vi.fn(),
}));
vi.mock('#hooks/useFormat', () => ({ useFormat: vi.fn() }));
vi.mock('#hooks/useSheetValue', () => ({ useSheetValue: vi.fn() }));

describe('budget group amount abbreviation', () => {
  const amount = 1_234_567;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAbbreviateAmounts).mockReturnValue(true);
    vi.mocked(useSheetValue).mockReturnValue(amount);

    const format = Object.assign((value: unknown) => `full-${String(value)}`, {
      compactCurrency: (value: number) => `compact-${value}`,
    });
    vi.mocked(useFormat).mockReturnValue(
      format as ReturnType<typeof useFormat>,
    );
  });

  it('abbreviates the tracking budget group amounts when enabled', () => {
    render(
      <TestProviders>
        <TrackingGroupMonth
          month="2026-01"
          group={generateCategoryGroup('Expenses')}
        />
      </TestProviders>,
    );

    expect(screen.getAllByText(`compact-${amount}`)).toHaveLength(3);
  });

  it('abbreviates the envelope budget group amounts when enabled', () => {
    render(
      <TestProviders>
        <EnvelopeExpenseGroupMonth
          month="2026-01"
          group={generateCategoryGroup('Expenses')}
        />
      </TestProviders>,
    );

    expect(screen.getAllByText(`compact-${amount}`)).toHaveLength(3);
  });

  it('abbreviates the envelope income group amount when enabled', () => {
    render(
      <TestProviders>
        <EnvelopeIncomeGroupMonth month="2026-01" />
      </TestProviders>,
    );

    expect(screen.getByText(`compact-${amount}`)).toBeInTheDocument();
  });

  it('keeps group amounts fully formatted when abbreviation is disabled', () => {
    vi.mocked(useAbbreviateAmounts).mockReturnValue(false);

    render(
      <TestProviders>
        <EnvelopeExpenseGroupMonth
          month="2026-01"
          group={generateCategoryGroup('Expenses')}
        />
      </TestProviders>,
    );

    expect(screen.getAllByText(`full-${amount}`)).toHaveLength(3);
  });
});
