import { Decimal } from '../common/decimal';
import { Gas, GASES } from '../factors/entities';
import { AggCell } from '../accounting/aggregation';
import { CellFilter } from './cell-filter';
import { AccountingEngine } from '../accounting/accounting.engine';
import { Caliber } from '../accounting/aggregation';
import { FactorIndex } from '../accounting/factor-index';

/**
 * 重述与差额分解。
 *
 * 口径三元组：A = 活动数据截止点、F = 因子库版本、G = GWP 集合。
 * 两个口径 A、B 的总排放（t CO2e）差为 Δ = E(B) − E(A)，需要拆成
 *   ΔActivity（活动数据变化）、ΔFactor（因子变化）、ΔGwp（潜势值变化）。
 *
 * 三者相互作用（协同项）：例如“补报的活动 × 新因子”的交叉增量既含
 * 活动也含因子。固定顺序逐项替换会把协同项全部判给顺序上的后替换者，
 * 顺序不同结果不同，不公平。
 *
 * 本实现采用 Shapley 值分解（等价于对 3! = 6 种替换顺序取平均，
 * 也即“Shapley–Owen / 对称平均边际贡献”）：
 *
 *   对因素 i，Δi = Σ_{S⊆N\\{i}} |S|! (n−|S|−1)! / n! · ( v(S∪{i}) − v(S) )
 *
 * 其中 v(S) 是“集合 S 中的因素取 B 取值、其余取 A 取值”这一混合口径下
 * 被考察汇总层级的总排放。
 *
 * 公平性：
 *  - 对称（互换任意两个因素的名字不改变它们的贡献）；
 *  - 有效（三因素贡献严格相加等于总差额，包括正负号）；
 *  - 对“什么都没贡献”的因素赋零；对加法可分的情形退化为精确分项。
 * 计算代价：
 *  - 需要评估 2^3 = 8 个混合口径（6 次边际差分，部分顶点复用），
 *    即最多 8 次全量核算；对 3 个因素是常数开销，与数据量线性相关。
 *    相比固定顺序法只需 4 个口径，代价是 2 倍核算，换来顺序无关的公平性。
 */

export type FactorKey = 'A' | 'F' | 'G';

/** 三个因素各取 A 端(false)还是 B 端(true)的一个顶点 */
export interface Vertex {
  a: boolean;
  f: boolean;
  g: boolean;
}

const FACTOR_WEIGHTS: Record<FactorKey, bigint[]> = (() => {
  // n=3 时 Shapley 权重 = s! (2-s)! / 6，s = 集合中其他因素个数
  // s=0: 2/6=1/3, s=1: 1/6, s=2: 2/6=1/3（用整数分子 + 公共分母 6）
  return {
    A: [2n, 1n, 2n],
    F: [2n, 1n, 2n],
    G: [2n, 1n, 2n],
  };
})();
const SHAPLEY_DENOM = 6n;

export function vertexId(v: Vertex): number {
  return (v.a ? 1 : 0) | (v.f ? 2 : 0) | (v.g ? 4 : 0);
}

export function allVertices(): Vertex[] {
  const out: Vertex[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ a: !!(i & 1), f: !!(i & 2), g: !!(i & 4) });
  }
  return out;
}

/** 顶点上的“被考察层级”总排放 kg CO2e，以及分气体 kg（供只换 GWP 的断言） */
export interface VertexValue {
  vertex: Vertex;
  kgByGas: Record<Gas, Decimal>;
  kgCo2e: Decimal;
}

function otherFactors(x: FactorKey): FactorKey[] {
  return (['A', 'F', 'G'] as FactorKey[]).filter((f) => f !== x);
}

function vertexWith(v: Vertex, factor: FactorKey, value: boolean): Vertex {
  const next = { ...v, [factor === 'A' ? 'a' : factor === 'F' ? 'f' : 'g']: value };
  return next;
}

function subsetSize(v: Vertex, factor: FactorKey): number {
  // v 中“取 B”的其他因素个数
  const others = otherFactors(factor);
  return others.filter((o) => (o === 'A' ? v.a : o === 'F' ? v.f : v.g)).length;
}

/**
 * 计算单因素 Shapley 贡献。
 * 差分沿该因素“取 B”边取：对所有不包含该因素的子集 S，
 * weight(S) · ( v(S∪{i}=B) − v(S=i=A) )。
 */
export function shapleyContribution(
  factor: FactorKey,
  values: Map<number, VertexValue>,
): { kgByGas: Record<Gas, Decimal>; kgCo2e: Decimal } {
  let kgCo2e = new Decimal(0);
  const kgByGas = { CO2: new Decimal(0), CH4: new Decimal(0), N2O: new Decimal(0) } as Record<Gas, Decimal>;

  for (const v of allVertices()) {
    // 只取“该因素在 A 端”的顶点作为差分起点（保证每个子集 S 出现一次）
    const factorAtA = factor === 'A' ? !v.a : factor === 'F' ? !v.f : !v.g;
    if (!factorAtA) continue;
    const s = subsetSize(v, factor);
    const numerator = FACTOR_WEIGHTS[factor][s];
    const low = values.get(vertexId(v))!;
    const high = values.get(vertexId(vertexWith(v, factor, true)))!;
    const diffCo2e = high.kgCo2e.minus(low.kgCo2e);
    kgCo2e = kgCo2e.plus(diffCo2e.mul(numerator.toString()).div(SHAPLEY_DENOM.toString()));
    for (const gas of GASES) {
      const diff = high.kgByGas[gas].minus(low.kgByGas[gas]);
      kgByGas[gas] = kgByGas[gas].plus(diff.mul(numerator.toString()).div(SHAPLEY_DENOM.toString()));
    }
  }
  return { kgByGas, kgCo2e };
}

export interface DecompositionPart {
  factor: 'activity' | 'factor' | 'gwp';
  kgCo2e: string;
  tonnesCo2e: string;
  kgByGas: Record<Gas, string>;
}

export interface DecompositionResult {
  level: string;
  caliberA: Caliber;
  caliberB: Caliber;
  total: { kgCo2e: string; tonnesCo2e: string };
  totalA: { kgCo2e: string; tonnesCo2e: string };
  totalB: { kgCo2e: string; tonnesCo2e: string };
  parts: DecompositionPart[];
  /** 三部分之和（与 total 做严格相等比较用） */
  sumOfParts: { kgCo2e: string; tonnesCo2e: string };
  /** |Δ| 的绝对差（应为 0），便于调用方断言 */
  residualKgCo2e: string;
}

/**
 * 引擎在 8 个顶点上做核算的回调。由 restatement.service 提供，
 * 本文件保持纯数学、可单测。
 */
export type VertexEvaluator = (v: Vertex) => Promise<{
  leafCells: AggCell[];
  gwp: Record<Gas, Decimal>;
  index: FactorIndex;
}>;

/**
 * 执行分解。evaluator 负责把顶点 (a,f,g) 映射到混合口径并核算出叶子格子，
 * filter 选出被考察的汇总层级。
 */
export async function decompose(
  caliberA: Caliber,
  caliberB: Caliber,
  evaluator: VertexEvaluator,
  filter: CellFilter,
  level: string,
): Promise<DecompositionResult> {
  const values = new Map<number, VertexValue>();
  for (const v of allVertices()) {
    const { leafCells, gwp } = await evaluator(v);
    const scoped = leafCells.filter((c) => filter.matches(c));
    let kgCo2e = new Decimal(0);
    const kgByGas = { CO2: new Decimal(0), CH4: new Decimal(0), N2O: new Decimal(0) } as Record<Gas, Decimal>;
    for (const c of scoped) {
      for (const gas of GASES) {
        kgByGas[gas] = kgByGas[gas].plus(c.kg[gas]);
        kgCo2e = kgCo2e.plus(c.kg[gas].mul(gwp[gas]));
      }
    }
    values.set(vertexId(v), { vertex: v, kgByGas, kgCo2e });
  }

  const v000 = values.get(vertexId({ a: false, f: false, g: false }))!;
  const v111 = values.get(vertexId({ a: true, f: true, g: true }))!;
  const totalDiff = v111.kgCo2e.minus(v000.kgCo2e);

  const mapName = { A: 'activity', F: 'factor', G: 'gwp' } as const;
  const parts: DecompositionPart[] = (['A', 'F', 'G'] as FactorKey[]).map((fk) => {
    const c = shapleyContribution(fk, values);
    return {
      factor: mapName[fk],
      kgCo2e: c.kgCo2e.toString(),
      tonnesCo2e: c.kgCo2e.div(1000).toString(),
      kgByGas: {
        CO2: c.kgByGas.CO2.toString(),
        CH4: c.kgByGas.CH4.toString(),
        N2O: c.kgByGas.N2O.toString(),
      },
    };
  });

  const sumKg = parts.reduce((acc, p) => acc.plus(p.kgCo2e), new Decimal(0));
  const residual = sumKg.minus(totalDiff);

  return {
    level,
    caliberA,
    caliberB,
    totalA: { kgCo2e: v000.kgCo2e.toString(), tonnesCo2e: v000.kgCo2e.div(1000).toString() },
    totalB: { kgCo2e: v111.kgCo2e.toString(), tonnesCo2e: v111.kgCo2e.div(1000).toString() },
    total: { kgCo2e: totalDiff.toString(), tonnesCo2e: totalDiff.div(1000).toString() },
    parts,
    sumOfParts: { kgCo2e: sumKg.toString(), tonnesCo2e: sumKg.div(1000).toString() },
    residualKgCo2e: residual.toString(),
  };
}
