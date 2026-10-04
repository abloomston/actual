import type { CSSProperties } from '@actual-app/components/styles';

import { CellValue, CellValueText } from '#components/spreadsheet/CellValue';
import { useFormat } from '#hooks/useFormat';
import { useGlobalPref } from '#hooks/useGlobalPref';
import type { Binding, SheetFields } from '#spreadsheet';

type SidebarBalanceProps<FieldName extends SheetFields<'account'>> = {
  binding: Binding<'account', FieldName>;
  style?: CSSProperties;
  testId?: string;
};

export function SidebarBalance<FieldName extends SheetFields<'account'>>({
  binding,
  style,
  testId,
}: SidebarBalanceProps<FieldName>) {
  const format = useFormat();
  const [abbreviateSidebarBalances] = useGlobalPref(
    'abbreviateSidebarBalances',
  );

  return (
    <CellValue<'account', FieldName> binding={binding} type="financial">
      {({ name, value }) => (
        <CellValueText<'account', FieldName>
          name={name}
          value={value}
          type="financial"
          formatter={amount =>
            abbreviateSidebarBalances !== false && typeof amount === 'number'
              ? format.compactCurrency(amount)
              : format(amount, 'financial')
          }
          data-testid={testId ?? name}
          style={{ textAlign: 'right', ...style }}
        />
      )}
    </CellValue>
  );
}
