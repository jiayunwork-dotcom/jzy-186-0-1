/**
 * 单位与量纲模型。
 *
 * 核算只涉及三个基础量纲：质量 mass、体积 volume、能量 energy。
 * 同一量纲的单位用十进倍率换算；跨量纲必须经由因子库参数：
 *   volume <-> mass : 密度 density（质量/体积）
 *   mass   <-> energy: 热值 NCV（能量/质量）
 *   volume <-> energy: 热值 NCV（能量/体积），或 density × mass-NCV
 *
 * 因子/参数的“比率单位”用复合单位表达：kg/GJ、kg/m³、GJ/t 等。
 */
export type Dimension = 'mass' | 'volume' | 'energy';

export interface SimpleUnit {
  kind: 'simple';
  name: string;
  dimension: Dimension;
  /** 该单位 1 个 = toBase 个基础单位（kg / m³ / GJ） */
  toBase: string;
}

export interface CompoundUnit {
  kind: 'compound';
  name: string;
  numerator: SimpleUnit;
  denominator: SimpleUnit;
}

export type Unit = SimpleUnit | CompoundUnit;

export interface ConversionParams {
  /** 密度，单位 mass/volume（kg 每 m³ 的数值），可为空 */
  density?: string;
  /** 质量基低位热值，单位 energy/mass（GJ 每 t 的数值），可为空 */
  ncvMass?: string;
  /** 体积基低位热值，单位 energy/volume（GJ 每 m³ 的数值），可为空 */
  ncvVolume?: string;
}
