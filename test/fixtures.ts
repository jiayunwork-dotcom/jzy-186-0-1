import { FactorVersionDraft, GwpSetDraft } from '../src/factors/store.interface';
import { FactorRowType, Scope } from '../src/factors/entities';

/**
 * 标准测试数据集：
 *  - fv-2023 / fv-2024 两个因子版本（适用期间 2023-01~2024-01 / 2024-01~开放），
 *    天然气 CO2 56.1 kg/GJ（含 CH4/N2O），柴油 kg/L，外购电 kg/kWh（范围二）；
 *  - ar5 / ar6 两套 GWP（CO2=1）。
 */
export function factorDraft(
  id: string,
  start: string,
  end: string | null,
  overrides: Partial<Record<string, number>> = {},
): FactorVersionDraft {
  const gasCO2 = overrides.gasCO2 ?? 56.1;
  const gasCH4 = overrides.gasCH4 ?? 0.001;
  const gasN2O = overrides.gasN2O ?? 0.0001;
  return {
    id,
    label: id,
    effectiveStart: start,
    effectiveEnd: end,
    rows: [
      // 天然气：能量因子 kg/GJ
      { fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_1, value: String(gasCO2), unit: 'kg/GJ' },
      { fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'CH4', scope: Scope.SCOPE_1, value: String(gasCH4), unit: 'kg/GJ' },
      { fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'N2O', scope: Scope.SCOPE_1, value: String(gasN2O), unit: 'kg/GJ' },
      // 柴油：体积因子 kg/L（另给密度/热值供换算测试）
      { fuelOrActivity: 'diesel', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_1, value: '2.68', unit: 'kg/L' },
      { fuelOrActivity: 'diesel', type: FactorRowType.EMISSION, gas: 'CH4', scope: Scope.SCOPE_1, value: '0.0001', unit: 'kg/L' },
      { fuelOrActivity: 'diesel', type: FactorRowType.EMISSION, gas: 'N2O', scope: Scope.SCOPE_1, value: '0.00002', unit: 'kg/L' },
      // 外购电：kg/kWh，范围二
      { fuelOrActivity: 'grid_electricity', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_2, value: '0.5', unit: 'kg/kWh' },
      { fuelOrActivity: 'grid_electricity', type: FactorRowType.EMISSION, gas: 'CH4', scope: Scope.SCOPE_2, value: '0', unit: 'kg/kWh' },
      { fuelOrActivity: 'grid_electricity', type: FactorRowType.EMISSION, gas: 'N2O', scope: Scope.SCOPE_2, value: '0', unit: 'kg/kWh' },
    ],
  };
}

export const GWP_AR5: GwpSetDraft = {
  id: 'ar5',
  label: 'IPCC AR5 (100yr)',
  values: [
    { gas: 'CO2', value: '1' },
    { gas: 'CH4', value: '28' },
    { gas: 'N2O', value: '265' },
  ],
};

export const GWP_AR6: GwpSetDraft = {
  id: 'ar6',
  label: 'IPCC AR6 (100yr)',
  values: [
    { gas: 'CO2', value: '1' },
    { gas: 'CH4', value: '29.8' },
    { gas: 'N2O', value: '273' },
  ],
};
