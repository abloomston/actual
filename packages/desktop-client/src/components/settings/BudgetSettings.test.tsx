import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BudgetSettings } from './BudgetSettings';

const mockSetHideMonthsWithoutTransactions = vi.fn();
const mockSetLearnCategories = vi.fn();
let hideMonthsWithoutTransactions: boolean | undefined;
let learnCategories: string | undefined;

vi.mock('#hooks/useGlobalPref', () => ({
  useGlobalPref: () => [
    hideMonthsWithoutTransactions,
    mockSetHideMonthsWithoutTransactions,
  ],
}));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: () => [learnCategories, mockSetLearnCategories],
}));

describe('BudgetSettings', () => {
  beforeEach(() => {
    hideMonthsWithoutTransactions = undefined;
    learnCategories = undefined;
    vi.clearAllMocks();
  });

  it('defaults to hiding past months without transactions', () => {
    render(<BudgetSettings />);

    expect(
      screen.getByRole('checkbox', {
        name: 'Hide past months with no transactions',
      }),
    ).toBeChecked();
  });

  it('defaults to automatically creating payee rules', () => {
    render(<BudgetSettings />);

    expect(
      screen.getByRole('checkbox', {
        name: 'Automatically create payee rules from categorized transactions',
      }),
    ).toBeChecked();
  });

  it('saves changes to the category-learning preference', () => {
    render(<BudgetSettings />);

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Automatically create payee rules from categorized transactions',
      }),
    );

    expect(mockSetLearnCategories).toHaveBeenCalledWith('false');
  });

  it('saves changes to the hide-months preference', () => {
    render(<BudgetSettings />);

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Hide past months with no transactions',
      }),
    );

    expect(mockSetHideMonthsWithoutTransactions).toHaveBeenCalledWith(false);
  });
});
