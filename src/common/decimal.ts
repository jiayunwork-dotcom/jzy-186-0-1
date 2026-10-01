import Decimal from 'decimal.js';
import { ValidationError } from './errors';

/**
 * 全局 Decimal 配置：40 位有效数字，足够表达单位换算链路上的任意中间量；
 * 舍入使用 HALF_UP。所有金额/质量/体积/能量均以 Decimal 精确运算，
 * 不使用 JS number，避免浮点误差进入差额分解。
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

/** 对外序列化时统一保留的千克/吨小数位数（吨 6 位，质量 6 位） */
export const KG_SCALE = 6;
export const TONNE_SCALE = 6;

/**
 * 把 Decimal 量化为固定小数位字符串。
 * 仅用于“展示/序列化”层；核算引擎内部永远保留全精度 Decimal。
 */
export function quantize(d: Decimal, scale: number = KG_SCALE): string {
  return d.toFixed(scale);
}

/** 千克 -> 吨 */
export function kgToTonnes(kg: Decimal, scale: number = TONNE_SCALE): string {
  return kg.div(1000).toFixed(scale);
}

/**
 * 最大余量法（Hamilton / largest remainder）配平：
 * 给定一组“同一总量的分解项”，先各自量化取整，再把因取整产生的残差
 * 按余量大小逐项 ±1 ulp 补到最大的若干项上，保证量化后各项之和
 * 与量化后的总量逐位相等。
 *
 * 调用前提：传入 parts 之和在内部精度上等于 total（引擎用线性结构
 * 保证这一点），这里只做离散化层面的严格配平。
 */
export function reconcile(
  total: Decimal,
  parts: Decimal[],
  scale: number = KG_SCALE,
): string[] {
  const factor = new Decimal(10).pow(scale);
  const scaledTotal = total.mul(factor);
  const scaledParts = parts.map((p) => p.mul(factor));

  const floorParts = scaledParts.map((p) => p.floor());
  const floorsSum = floorParts.reduce((a, b) => a.plus(b), new Decimal(0));
  const totalFloor = scaledTotal.floor();
  let units = totalFloor.minus(floorsSum).toNumber();

  // 余量（小数部分），按从大到小排序
  const order = scaledParts
    .map((p, i) => ({ i, rem: p.minus(p.floor()) }))
    .sort((a, b) => b.rem.comparedTo(a.rem) || a.i - b.i);

  const result = floorParts.map((p) => p);
  if (units >= 0) {
    for (let k = 0; units > 0; k = (k + 1) % order.length) {
      result[order[k % order.length].i] = result[order[k % order.length].i].plus(1);
      units--;
    }
  } else {
    // 极端情况下（scale 很小、部分项为负）向下修正
    const negOrder = [...order].sort((a, b) => a.rem.comparedTo(b.rem) || a.i - b.i);
    let k = 0;
    while (units < 0) {
      result[negOrder[k % negOrder.length].i] = result[negOrder[k % negOrder.length].i].minus(1);
      units++;
      k++;
    }
  }
  return result.map((p) => p.div(factor).toFixed(scale));
}

/** 严格解析外部传入的数值（字符串或 number），拒绝 NaN/Infinity。 */
export function parseFiniteDecimal(raw: unknown, field: string): Decimal {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw new ValidationError(field, '必须是有限数');
    }
    return new Decimal(raw);
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    let d: Decimal;
    try {
      d = new Decimal(raw.trim());
    } catch {
      throw new ValidationError(field, '不是合法的十进制数');
    }
    if (!d.isFinite()) {
      throw new ValidationError(field, '必须是有限数');
    }
    return d;
  }
  throw new ValidationError(field, '不是合法的十进制数');
}

/** 正值校验（零允许，表示无活动；负数不允许） */
export function requireNonNegative(d: Decimal, field: string): Decimal {
  if (d.isNegative()) {
    throw new ValidationError(field, '数量不能为负');
  }
  return d;
}
