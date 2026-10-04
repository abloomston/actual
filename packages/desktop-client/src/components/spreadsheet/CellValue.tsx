// @ts-strict-ignore
import React from 'react';
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react';

import { Text } from '@actual-app/components/text';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { useFormat } from '#hooks/useFormat';
import type { FormatType } from '#hooks/useFormat';
import { useSheetName } from '#hooks/useSheetName';
import { useSheetValue } from '#hooks/useSheetValue';
import type {
  Binding,
  SheetFields,
  SheetNames,
  Spreadsheets,
} from '#spreadsheet';

type CellValueProps<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
> = {
  children?: ({
    type,
    name,
    value,
  }: {
    type?: FormatType;
    name: string;
    value: Spreadsheets[SheetName][FieldName];
    abbreviate?: boolean;
  }) => ReactNode;
  binding: Binding<SheetName, FieldName>;
  type?: FormatType;
  abbreviate?: boolean;
};

export function CellValue<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
>({
  type,
  binding,
  children,
  abbreviate,
  ...props
}: CellValueProps<SheetName, FieldName>) {
  const { fullSheetName } = useSheetName(binding);
  const sheetValue = useSheetValue(binding);

  return typeof children === 'function' ? (
    <>
      {children({
        type,
        name: fullSheetName,
        value: sheetValue,
        abbreviate,
      })}
    </>
  ) : (
    <CellValueText
      type={type}
      name={fullSheetName}
      value={sheetValue}
      abbreviate={abbreviate}
      {...props}
    />
  );
}

const PRIVACY_FILTER_TYPES = ['financial', 'financial-with-sign'];

type CellValueTextProps<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
> = Omit<ComponentPropsWithoutRef<typeof Text>, 'value' | 'as'> & {
  type?: FormatType;
  name: string;
  value: Spreadsheets[SheetName][FieldName];
  style?: CSSProperties;
  formatter?: (
    value: Spreadsheets[SheetName][FieldName],
    type?: FormatType,
  ) => string;
  abbreviate?: boolean;
};

export function CellValueText<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
>({
  type,
  name,
  value,
  formatter,
  abbreviate,
  style,
  ...props
}: CellValueTextProps<SheetName, FieldName>) {
  const format = useFormat();
  const isFinancial =
    type === 'financial' ||
    type === 'financial-with-sign' ||
    type === 'financial-no-decimals';
  const sharedProps = {
    style,
    'data-testid': name,
    'data-cellname': name,
    ...props,
  };

  if (isFinancial) {
    return (
      <FinancialText
        {...sharedProps}
        style={{
          whiteSpace: 'nowrap',
          ...style,
        }}
      >
        <PrivacyFilter
          activationFilters={[PRIVACY_FILTER_TYPES.includes(type)]}
        >
          {formatter
            ? formatter(value, type)
            : abbreviate &&
                typeof value === 'number' &&
                (type === 'financial' ||
                  type === 'financial-with-sign' ||
                  type === 'financial-no-decimals')
              ? `${
                  type === 'financial-with-sign' && value >= 0 ? '+' : ''
                }${format.compactCurrency(value)}`
              : format(value, type)}
        </PrivacyFilter>
      </FinancialText>
    );
  }

  return (
    <Text {...sharedProps}>
      <PrivacyFilter activationFilters={[PRIVACY_FILTER_TYPES.includes(type)]}>
        {formatter ? formatter(value, type) : format(value, type)}
      </PrivacyFilter>
    </Text>
  );
}
