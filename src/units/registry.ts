import { Unit, SimpleUnit, CompoundUnit } from './model';
import { ValidationError } from '../common/errors';

/**
 * 内置单位注册表。前缀单位全部精确十进倍率，换算无精度损失。
 * 基础单位：质量 kg、体积 m³、能量 GJ。
 */
const SIMPLE: Record<string, SimpleUnit> = {};

function reg(name: string, dimension: SimpleUnit['dimension'], toBase: string): void {
  SIMPLE[name] = { kind: 'simple', name, dimension, toBase };
}

// 质量（基础 kg）。t 与 kg 为精确 1000 倍。
reg('kg', 'mass', '1');
reg('t', 'mass', '1000');
reg('g', 'mass', '0.001');
reg('mg', 'mass', '0.000001');

// 体积（基础 m³）。L 与 m³ 为精确 1000 倍。
reg('m3', 'volume', '1');
reg('m³', 'volume', '1');
reg('L', 'volume', '0.001');
reg('l', 'volume', '0.001');

// 能量（基础 GJ）
reg('GJ', 'energy', '1');
reg('MJ', 'energy', '0.001');
reg('kJ', 'energy', '0.000001');
reg('kWh', 'energy', '0.0036');
reg('TJ', 'energy', '1000');

/** 复合单位缓存，如 kg/GJ、kg/m3、GJ/t */
const COMPOUND_CACHE = new Map<string, CompoundUnit>();

export function getSimpleUnit(name: string): SimpleUnit {
  const u = SIMPLE[name];
  if (!u) {
    throw new ValidationError('unit', `未知单位：${name}`);
  }
  return u;
}

export function parseUnit(name: string): Unit {
  if (SIMPLE[name]) return SIMPLE[name];
  const cached = COMPOUND_CACHE.get(name);
  if (cached) return cached;

  // 支持 "kg/GJ" 与 "kg per GJ" 两种写法
  const parts = name.split(/\/| per /);
  if (parts.length === 2) {
    const num = getSimpleUnit(parts[0].trim());
    const den = getSimpleUnit(parts[1].trim());
    const compound: CompoundUnit = { kind: 'compound', name, numerator: num, denominator: den };
    COMPOUND_CACHE.set(name, compound);
    return compound;
  }
  throw new ValidationError('unit', `未知单位：${name}`);
}

export function isSimpleUnitName(name: string): boolean {
  try {
    return parseUnit(name).kind === 'simple';
  } catch {
    return false;
  }
}
