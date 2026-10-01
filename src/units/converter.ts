import { Decimal } from '../common/decimal';
import { ConversionParams, Dimension, SimpleUnit } from './model';
import { getSimpleUnit, parseUnit } from './registry';
import { ValidationError } from '../common/errors';

/**
 * 单位换算器。
 *
 * 约定：因子库里的密度/热值是“带单位”的复合量（如 0.8 kg/m³、0.05 GJ/kg），
 * 进入换算器前统一由 convertCompoundToBases 折算为基础单位比值，
 * 因此这里 params 中的数值单位恒为：
 *   density   : kg/m³
 *   ncvMass   : GJ/kg
 *   ncvVolume : GJ/m³
 */

function dimensionOf(unitName: string): Dimension {
  return (getSimpleUnit(unitName) as SimpleUnit).dimension;
}

function toBaseAmount(amount: Decimal, unitName: string): Decimal {
  const u = getSimpleUnit(unitName);
  return amount.mul(u.toBase);
}

function fromBaseAmount(baseAmount: Decimal, unitName: string): Decimal {
  const u = getSimpleUnit(unitName);
  return baseAmount.div(u.toBase);
}

/**
 * 把复合单位表示的因子值折算为“基础单位/基础单位”的比值。
 * 例：56.1 kg/GJ -> 56.1（kg/GJ）；0.8 kg/L -> 800（kg/m³）；
 *     50 GJ/t -> 0.05（GJ/kg）。
 */
export function convertCompoundToBases(value: Decimal, compoundUnitName: string): Decimal {
  const u = parseUnit(compoundUnitName);
  if (u.kind !== 'compound') {
    throw new ValidationError(
      'factorUnit',
      `期望复合单位（如 kg/GJ），实际为简单单位 ${compoundUnitName}`,
    );
  }
  // value [num/den] -> base: value * num.toBase / den.toBase
  return value.mul(u.numerator.toBase).div(u.denominator.toBase);
}

/** 是否具备跨量纲换算所需的参数 */
function requiredParam(
  from: Dimension,
  to: Dimension,
  params: ConversionParams,
): { key: 'density' | 'ncvMass' | 'ncvVolume' } {
  if (from === 'mass' && to === 'volume') return { key: 'density' };
  if (from === 'volume' && to === 'mass') return { key: 'density' };
  if (from === 'mass' && to === 'energy') return { key: 'ncvMass' };
  if (from === 'energy' && to === 'mass') return { key: 'ncvMass' };
  if (from === 'volume' && to === 'energy') return { key: 'ncvVolume' };
  if (from === 'energy' && to === 'volume') return { key: 'ncvVolume' };
  throw new ValidationError('unit', `不支持的量纲换算：${from} -> ${to}`);
}

/**
 * 活动数据数量换算。
 *
 * 同量纲走十进倍率（精确）；跨量纲走因子参数。
 * 乘法优先的运算顺序尽量保证“可终止十进制”场景下来回换算严格不变
 * （例如 100 m³ ×0.8 kg/m³ ×0.05 GJ/kg = 4 GJ，反向 4 ÷0.05 ÷0.8 = 100 m³）。
 */
export function convertActivity(
  amount: Decimal,
  fromUnit: string,
  toUnit: string,
  params: ConversionParams = {},
): Decimal {
  const from = getSimpleUnit(fromUnit);
  const to = getSimpleUnit(toUnit);

  const fromBase = toBaseAmount(amount, fromUnit); // kg | m³ | GJ

  if (from.dimension === to.dimension) {
    return fromBaseAmount(fromBase, toUnit);
  }

  const { key } = requiredParam(from.dimension, to.dimension, params);
  const factor = params[key];
  if (factor === undefined || factor === null || factor === '') {
    throw new ValidationError(
      'unit',
      `无法把 ${fromUnit}（${from.dimension}）换算到 ${toUnit}（${to.dimension}）：缺少 ${key}`,
      { missingParam: key },
    );
  }
  const f = new Decimal(factor);
  if (f.lessThanOrEqualTo(0)) {
    throw new ValidationError(key, '换算参数必须为正数');
  }

  // 先跨量纲到目标量纲的基础单位，再折算到目标单位
  let targetBase: Decimal;
  switch (`${from.dimension}->${to.dimension}`) {
    // 以体积为记录单位
    case 'volume->mass':
      targetBase = fromBase.mul(f); // m³ × kg/m³
      break;
    case 'volume->energy':
      targetBase = fromBase.mul(f); // m³ × GJ/m³
      break;
    // 以质量为记录单位
    case 'mass->volume':
      targetBase = fromBase.div(f); // kg ÷ kg/m³
      break;
    case 'mass->energy':
      targetBase = fromBase.mul(f); // kg × GJ/kg
      break;
    // 以能量为记录单位
    case 'energy->mass':
      targetBase = fromBase.div(f); // GJ ÷ GJ/kg
      break;
    case 'energy->volume':
      targetBase = fromBase.div(f); // GJ ÷ GJ/m³
      break;
    default:
      throw new ValidationError('unit', `不支持的量纲换算：${from.dimension} -> ${to.dimension}`);
  }
  return fromBaseAmount(targetBase, toUnit);
}

/** 校验能否换算（导入时做预检，错误指向具体字段） */
export function assertConvertible(
  fromUnit: string,
  toUnit: string,
  params: ConversionParams = {},
): void {
  const from = getSimpleUnit(fromUnit);
  const to = getSimpleUnit(toUnit);
  if (from.dimension === to.dimension) return;
  requiredParam(from.dimension, to.dimension, params);
  const { key } = requiredParam(from.dimension, to.dimension, params);
  const v = params[key];
  if (v === undefined || v === null || v === '') {
    throw new ValidationError('unit', `单位 ${fromUnit} 无法换算到因子要求的单位 ${toUnit}：缺少 ${key}`, {
      missingParam: key,
    });
  }
}

/** 把任意活动数量折算成某量纲基础单位（kg / m³ / GJ） */
export function toDimensionBase(
  amount: Decimal,
  fromUnit: string,
  target: Dimension,
  params: ConversionParams,
): Decimal {
  const targetBaseUnit = target === 'mass' ? 'kg' : target === 'volume' ? 'm3' : 'GJ';
  return convertActivity(amount, fromUnit, targetBaseUnit, params);
}

export { dimensionOf };
