import { useMemo } from 'react';

import { q } from '@actual-app/core/shared/query';

import { useQuery } from '#hooks/useQuery';

export function useBudgetMonthsWithTransactions() {
  const { data } = useQuery<{ month: string }>(
    () =>
      q('transactions')
        .groupBy({ $month: '$date' })
        .select([{ month: { $month: '$date' } }]),
    [],
  );

  return useMemo(
    () => (data ? new Set(data.map(({ month }) => month)) : null),
    [data],
  );
}
