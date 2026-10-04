import type { ReactNode } from 'react';
import { Trans } from 'react-i18next';

import { amountToInteger } from '@actual-app/core/shared/util';
import type { PeriodicTemplate } from '@actual-app/core/types/models/templates';
import type { TransObjectLiteral } from '@actual-app/core/types/util';

import { FinancialText } from '#components/FinancialText';
import { useFormat } from '#hooks/useFormat';

type FixedAutomationReadOnlyProps = {
  template: PeriodicTemplate;
};

export function FixedAutomationReadOnly({
  template,
}: FixedAutomationReadOnlyProps) {
  const format = useFormat();
  const amount = format(
    amountToInteger(template.amount, format.currency.decimalPlaces),
    'financial',
  );
  const periodAmount = template.period?.amount ?? 1;
  const periodUnit = template.period?.period ?? 'month';
  const totalAmount =
    template.totalAmount == null
      ? null
      : format(
          amountToInteger(template.totalAmount, format.currency.decimalPlaces),
          'financial',
        );

  let sentence: ReactNode;
  switch (periodUnit) {
    case 'day':
      sentence = (
        <Trans count={periodAmount}>
          Budget{' '}
          <FinancialText>{{ amount } as TransObjectLiteral}</FinancialText>{' '}
          every {{ count: periodAmount }} days
        </Trans>
      );
      break;
    case 'week':
      sentence = (
        <Trans count={periodAmount}>
          Budget{' '}
          <FinancialText>{{ amount } as TransObjectLiteral}</FinancialText>{' '}
          every {{ count: periodAmount }} weeks
        </Trans>
      );
      break;
    case 'month':
      sentence = (
        <Trans count={periodAmount}>
          Budget{' '}
          <FinancialText>{{ amount } as TransObjectLiteral}</FinancialText>{' '}
          every {{ count: periodAmount }} months
        </Trans>
      );
      break;
    case 'year':
      sentence = (
        <Trans count={periodAmount}>
          Budget{' '}
          <FinancialText>{{ amount } as TransObjectLiteral}</FinancialText>{' '}
          every {{ count: periodAmount }} years
        </Trans>
      );
      break;
    default:
      return null;
  }

  return (
    <>
      {sentence}
      {totalAmount != null && (
        <>
          {' '}
          <Trans>
            Stop adding funds when the envelope reaches{' '}
            <FinancialText>
              {{ amount: totalAmount } as TransObjectLiteral}
            </FinancialText>
            .
          </Trans>
        </>
      )}
    </>
  );
}
