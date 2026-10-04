import { useGlobalPref } from './useGlobalPref';

export type AmountAbbreviationTarget = 'accounts' | 'budget';

export function useAbbreviateAmounts(target: AmountAbbreviationTarget) {
  const [targets] = useGlobalPref('abbreviateAmounts');
  return targets?.includes(target) ?? target === 'accounts';
}
