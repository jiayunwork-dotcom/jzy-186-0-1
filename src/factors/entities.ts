/** 范围一（直接排放）/ 范围二（外购能源间接排放） */
export enum Scope {
  SCOPE_1 = 1,
  SCOPE_2 = 2,
}

export type Gas = 'CO2' | 'CH4' | 'N2O';
export const GASES: Gas[] = ['CO2', 'CH4', 'N2O'];

/** 因子行类型：排放因子，或用于单位换算的密度/热值 */
export enum FactorRowType {
  EMISSION = 'emission',
  DENSITY = 'density',
  NCV_MASS = 'ncv_mass',
  NCV_VOLUME = 'ncv_volume',
}

/**
 * 因子行。同一 (factorVersionId, fuelOrActivity, type, gas?) 在适用期间内
 * 唯一；换算参数（密度/热值）不带 gas。
 * 数值统一带原始单位（如 56.1 kg/GJ、0.8 kg/m3、0.05 GJ/kg），
 * 计算时由单位换算器折算，因子“数字”与“单位”永远成对保留，满足追溯。
 */
export interface FactorRow {
  id: string;
  factorVersionId: string;
  fuelOrActivity: string;
  type: FactorRowType;
  gas?: Gas;
  scope?: Scope;
  value: string; // 高精度十进制字符串
  unit: string; // 复合单位，如 kg/GJ
}

/** 因子库版本（不可变；发布后只能再发新版，不能修改） */
export interface FactorVersion {
  id: string;
  label: string;
  effectiveStart: string; // YYYY-MM，含
  effectiveEnd: string | null; // YYYY-MM，不含；null 表示开放
  publishedAt: string; // ISO 时间戳
  rows: FactorRow[];
}

/** 单个气体的全球变暖潜势值（CO2 恒为 1） */
export interface GwpValue {
  gas: Gas;
  value: string;
}

/** GWP 集合（AR5 / AR6 等），不可变 */
export interface GwpSet {
  id: string;
  label: string;
  publishedAt: string;
  values: GwpValue[];
}
