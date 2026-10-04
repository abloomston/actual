import React from 'react';
import { Trans } from 'react-i18next';

import { Text } from '@actual-app/components/text';

import { Checkbox } from '#components/forms';
import { useGlobalPref } from '#hooks/useGlobalPref';

import { Setting } from './UI';

export function BudgetSettings() {
  const [
    hideMonthsWithoutTransactions = true,
    setHideMonthsWithoutTransactions,
  ] = useGlobalPref('hideBudgetMonthsWithNoTransactions');

  return (
    <Setting>
      <Text style={{ display: 'flex' }}>
        <Checkbox
          id="settings-hideBudgetMonthsWithNoTransactions"
          checked={hideMonthsWithoutTransactions}
          onChange={e =>
            setHideMonthsWithoutTransactions(e.currentTarget.checked)
          }
        />
        <label htmlFor="settings-hideBudgetMonthsWithNoTransactions">
          <Trans>Hide past months with no transactions</Trans>
        </label>
      </Text>
    </Setting>
  );
}
