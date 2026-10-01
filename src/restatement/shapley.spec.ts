import Decimal from 'decimal.js';
import { decompose, Vertex } from './shapley';
import { Caliber } from '../accounting/aggregation';
import { Gas } from '../factors/entities';
import { AggCell } from '../accounting/aggregation';
import { Scope } from '../factors/entities';

/**
 * 用乘法模型直接验证 Shapley 的博弈论性质：
 * 物理 kg CO2 = activity × factor；co2e = kg × gwp。
 * evaluator 按顶点取 (A_a, F_f, G_g)，构造一个叶子格子。
 */
function makeEvaluator(A: [number, number], F: [number, number], G: [number, number]) {
  const zero = { CO2: new Decimal(0), CH4: new Decimal(0), N2O: new Decimal(0) } as Record<Gas, Decimal>;
  return async (v: Vertex) => {
    const a = v.a ? A[1] : A[0];
    const f = v.f ? F[1] : F[0];
    const g = v.g ? G[1] : G[0];
    const cell: AggCell = {
      plantId: 'P',
      sourceId: 'S',
      month: '2024-01',
      scope: Scope.SCOPE_1,
      kg: { ...zero, CO2: new Decimal(a).mul(f) },
      recordIds: ['x'],
    };
    const gwp = { ...zero, CO2: new Decimal(g) };
    return {
      leafCells: [cell],
      gwp,
      index: null as never,
    };
  };
}

const caliberA: Caliber = { activitySeq: 0, factorVersionId: 'F0', gwpSetId: 'G0' };
const caliberB: Caliber = { activitySeq: 1, factorVersionId: 'F1', gwpSetId: 'G1' };

const acceptAll = { matches: () => true } as never;

describe('Shapley 分解的数学性质', () => {
  test('有效性：三部分之和严格等于总差额（任意乘法取值）', async () => {
    const cases: Array<[ [number, number], [number, number], [number, number] ]> = [
      [[100, 106], [56.1, 59.466], [1, 1]],
      [[10, 20], [3, 7], [28, 29.8]],
      [[1, 3], [5, 2], [265, 273]],
      [[100, 100], [56.1, 60], [1, 1]],
    ];
    for (const [A, F, G] of cases) {
      const d = await decompose(caliberA, caliberB, makeEvaluator(A, F, G), acceptAll, 'test');
      expect(new Decimal(d.residualKgCo2e).equals(0)).toBe(true);
      const total = new Decimal(A[1]).mul(F[1]).mul(G[1]).minus(new Decimal(A[0]).mul(F[0]).mul(G[0]));
      expect(new Decimal(d.total.kgCo2e).equals(total)).toBe(true);
    }
  });

  test('零贡献（dummy）：GWP 不变时 gwp 部分恒为 0', async () => {
    const d = await decompose(caliberA, caliberB, makeEvaluator([100, 106], [56.1, 59.466], [1, 1]), acceptAll, 'test');
    expect(new Decimal(d.parts.find((p) => p.factor === 'gwp')!.kgCo2e).equals(0)).toBe(true);
  });

  test('对称性：当 A 与 F 在博弈中可互换（端点相同）时，两因素贡献相等', async () => {
    // A0=F0=100, A1=F1=106, G 恒为 1 -> v 对 A、F 完全对称
    const d = await decompose(caliberA, caliberB, makeEvaluator([100, 106], [100, 106], [1, 1]), acceptAll, 'test');
    const act = new Decimal(d.parts.find((p) => p.factor === 'activity')!.kgCo2e);
    const fac = new Decimal(d.parts.find((p) => p.factor === 'factor')!.kgCo2e);
    expect(act.equals(fac)).toBe(true);
    // 总差 = 106² − 100² = 1236，对半 = 618
    expect(act.toString()).toBe('618');
  });

  test('加性可分情形（G 变化只线性缩放）分解精确', async () => {
    // 活动/因子都不变，仅 GWP 1 -> 28：gwp 部分 = kg×27
    const d = await decompose(caliberA, caliberB, makeEvaluator([100, 100], [1, 1], [1, 28]), acceptAll, 'test');
    const gwp = d.parts.find((p) => p.factor === 'gwp')!;
    expect(new Decimal(gwp.kgCo2e).equals(100 * 27)).toBe(true);
    expect(new Decimal(d.total.kgCo2e).equals(100 * 27)).toBe(true);
  });
});
