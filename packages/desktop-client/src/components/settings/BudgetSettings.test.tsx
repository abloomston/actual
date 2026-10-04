import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BudgetSettings } from './BudgetSettings';

const mockSetHideMonthsWithoutTransactions = vi.fn();
let hideMonthsWithoutTransactions: boolean | undefined;

vi.mock('#hooks/useGlobalPref', () => ({
  useGlobalPref: () => [
    hideMonthsWithoutTransactions,
    mockSetHideMonthsWithoutTransactions,
  ],
}));

describe('BudgetSettings', () => {
  beforeEach(() => {
    hideMonthsWithoutTransactions = undefined;
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
