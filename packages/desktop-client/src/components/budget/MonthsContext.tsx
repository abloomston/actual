// @ts-strict-ignore
import React, { createContext } from 'react';
import type { ReactNode } from 'react';

import * as monthUtils from '@actual-app/core/shared/months';

export type MonthBounds = {
  start: string;
  end: string;
};

export function getValidMonthBounds(
  bounds: MonthBounds,
  startMonth: undefined | string,
  endMonth: string,
) {
  return {
    start: startMonth < bounds.start ? bounds.start : startMonth,
    end: endMonth > bounds.end ? bounds.end : endMonth,
  };
}

export function getVisibleBudgetMonths(
  months: string[],
  monthsWithTransactions: ReadonlySet<string> | null,
  hideMonthsWithoutTransactions: boolean,
  currentMonth: string,
) {
  if (!hideMonthsWithoutTransactions || monthsWithTransactions === null) {
    return months;
  }

  return months.filter(
    month => month >= currentMonth || monthsWithTransactions.has(month),
  );
}

type MonthsContextProps = {
  months: string[];
  type: string;
};

export const MonthsContext = createContext<MonthsContextProps>(null);

type MonthsProviderProps = {
  startMonth: string | undefined;
  numMonths: number;
  monthBounds: MonthBounds;
  type: string;
  children: ReactNode;
  monthsWithTransactions: ReadonlySet<string> | null;
  hideMonthsWithoutTransactions: boolean;
};

export function MonthsProvider({
  startMonth,
  numMonths,
  monthBounds,
  type,
  children,
  monthsWithTransactions,
  hideMonthsWithoutTransactions,
}: MonthsProviderProps) {
  const endMonth = monthUtils.addMonths(startMonth, numMonths - 1);
  const bounds = getValidMonthBounds(monthBounds, startMonth, endMonth);
  const months = getVisibleBudgetMonths(
    monthUtils.rangeInclusive(bounds.start, bounds.end),
    monthsWithTransactions,
    hideMonthsWithoutTransactions,
    monthUtils.currentMonth(),
  );

  return (
    <MonthsContext.Provider value={{ months, type }}>
      {children}
    </MonthsContext.Provider>
  );
}
