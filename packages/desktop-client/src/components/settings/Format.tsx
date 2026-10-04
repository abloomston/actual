// @ts-strict-ignore
import React, { useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgExpandArrow } from '@actual-app/components/icons/v0';
import { Menu } from '@actual-app/components/menu';
import { Popover } from '@actual-app/components/popover';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { tokens } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import { numberFormats } from '@actual-app/core/shared/util';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { css } from '@emotion/css';

import { Checkbox } from '#components/forms';
import { useSidebar } from '#components/sidebar/SidebarProvider';
import type { AmountAbbreviationTarget } from '#hooks/useAbbreviateAmounts';
import { useDateFormat } from '#hooks/useDateFormat';
import { useDaysOfWeek } from '#hooks/useDaysOfWeek';
import { useGlobalPref } from '#hooks/useGlobalPref';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { saveSyncedPrefs } from '#prefs/prefsSlice';
import { useDispatch } from '#redux';

import { Column, Setting } from './UI';

const dateFormats: { value: SyncedPrefs['dateFormat']; label: string }[] = [
  { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY' },
  { value: 'dd/MM/yyyy', label: 'DD/MM/YYYY' },
  { value: 'yyyy-MM-dd', label: 'YYYY-MM-DD' },
  { value: 'MM.dd.yyyy', label: 'MM.DD.YYYY' },
  { value: 'dd.MM.yyyy', label: 'DD.MM.YYYY' },
  { value: 'dd-MM-yyyy', label: 'DD-MM-YYYY' },
];

function AbbreviateAmountsSelect() {
  const { t } = useTranslation();
  const [savedTargets = ['accounts'], setTargets] =
    useGlobalPref('abbreviateAmounts');
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef(null);
  const targets: AmountAbbreviationTarget[] = savedTargets;
  const selectedLabels = targets.map(target =>
    target === 'accounts' ? t('Accounts pane') : t('Budget view'),
  );

  const toggleTarget = (target: AmountAbbreviationTarget) => {
    setTargets(
      targets.includes(target)
        ? targets.filter(selected => selected !== target)
        : [...targets, target],
    );
  };

  return (
    <>
      <Button
        ref={triggerRef}
        variant="normal"
        aria-label={t('Abbreviate amounts in')}
        onPress={() => setIsOpen(true)}
        style={{ width: '100%' }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {selectedLabels.length ? selectedLabels.join(', ') : t('None')}
        </span>
        <SvgExpandArrow style={{ width: 7, height: 7, marginLeft: 5 }} />
      </Button>
      <Popover
        triggerRef={triggerRef}
        placement="bottom start"
        isOpen={isOpen}
        onOpenChange={() => setIsOpen(false)}
        style={{ width: 200 }}
      >
        <Menu<AmountAbbreviationTarget>
          onMenuSelect={toggleTarget}
          items={[
            {
              name: 'accounts',
              text: t('Accounts pane'),
              toggle: targets.includes('accounts'),
            },
            {
              name: 'budget',
              text: t('Budget view'),
              toggle: targets.includes('budget'),
            },
          ]}
        />
      </Popover>
    </>
  );
}

export function FormatSettings() {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const sidebar = useSidebar();
  const [_firstDayOfWeekIdx, setFirstDayOfWeekIdxPref] =
    useSyncedPref('firstDayOfWeekIdx'); // Sunday;
  const firstDayOfWeekIdx = _firstDayOfWeekIdx || '0';
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const [, setDateFormatPref] = useSyncedPref('dateFormat');
  const [_numberFormat] = useSyncedPref('numberFormat');
  const numberFormat = _numberFormat || 'comma-dot';
  const [hideFraction, setHideFractionPref] = useSyncedPref('hideFraction');

  const daysOfWeek = useDaysOfWeek();

  const selectButtonClassName = css({
    '&[data-hovered]': {
      backgroundColor: theme.buttonNormalBackgroundHover,
    },
  });

  return (
    <Setting
      primaryAction={
        <View
          style={{
            flexDirection: 'column',
            gap: '1em',
            width: '100%',
            [`@media (min-width: ${
              sidebar.floating
                ? tokens.breakpoint_small
                : tokens.breakpoint_medium
            })`]: {
              flexDirection: 'row',
            },
          }}
        >
          <Column title={t('Numbers')}>
            <Select
              key={String(hideFraction)} // needed because label does not update
              value={numberFormat}
              onChange={format => {
                void dispatch(
                  saveSyncedPrefs({ prefs: { numberFormat: format } }),
                );
              }}
              options={numberFormats.map(f => [
                f.value,
                String(hideFraction) === 'true' ? f.labelNoFraction : f.label,
              ])}
              className={selectButtonClassName}
            />

            <Text style={{ display: 'flex' }}>
              <Checkbox
                id="settings-textDecimal"
                checked={String(hideFraction) === 'true'}
                onChange={e =>
                  setHideFractionPref(String(e.currentTarget.checked))
                }
              />
              <label htmlFor="settings-textDecimal">
                <Trans>Hide decimal places</Trans>
              </label>
            </Text>

            <View style={{ gap: 4 }}>
              <Text>
                <Trans>Abbreviate amounts in</Trans>
              </Text>
              <AbbreviateAmountsSelect />
            </View>
          </Column>

          <Column title={t('Dates')}>
            <Select
              value={dateFormat}
              onChange={format => setDateFormatPref(format)}
              options={dateFormats.map(f => [f.value, f.label])}
              className={selectButtonClassName}
            />
          </Column>

          <Column title={t('First day of the week')}>
            <Select
              value={firstDayOfWeekIdx}
              onChange={idx => setFirstDayOfWeekIdxPref(idx)}
              options={Object.entries(daysOfWeek)}
              className={selectButtonClassName}
            />
          </Column>
        </View>
      }
    >
      <Text>
        <Trans>
          <strong>Formatting</strong> does not affect how budget data is stored,
          and can be changed at any time.
        </Trans>
      </Text>
    </Setting>
  );
}
