import { Decimal } from '../common/decimal';
import { Gas, GASES, Scope } from '../factors/entities';
import { AggCell } from './aggregation';

/**
 * 汇总投影（rollup）。
 *
 * 叶子格子（plant/source/month/scope）是唯一直接来自核算的事实；
 * 所有更高层级都由叶子“线性求和”得到：
 *   - 厂区合计 = 该厂区各排放源之和
 *   - 年/期合计 = 各月之和
 *   - 公司合计 = 各厂区之和
 *   - 范围一/二分别汇总；总量 = 范围一 + 范围二
 * 因此测试中的“厂区合计=排放源之和、年合计=各月之和”由构造保证。
 */
export type RollupLevel =
  | 'company' // 公司 × 月份 × 范围（跨厂区）
  | 'plant' // 厂区 × 月份 × 范围
  | 'source' // 厂区 × 排放源 × 月份 × 范围（叶子）
  | 'plant-year' // 厂区 × 年份 × 范围
  | 'company-year'; // 公司 × 年份 × 范围

export interface RollupRow {
  level: RollupLevel;
  plantId: string | null;
  sourceId: string | null;
  month: string | null;
  year: string | null;
  scope: Scope;
  kg: Record<Gas, string>;
  kgCo2e: string;
  tonnesCo2e: string;
  recordIds: string[];
}

function sumCells(cells: AggCell[]): { kg: Record<Gas, Decimal>; recordIds: string[] } {
  const kg = { CO2: new Decimal(0), CH4: new Decimal(0), N2O: new Decimal(0) } as Record<Gas, Decimal>;
  const recordIds: string[] = [];
  for (const c of cells) {
    for (const g of GASES) kg[g] = kg[g].plus(c.kg[g]);
    recordIds.push(...c.recordIds);
  }
  return { kg, recordIds: [...new Set(recordIds)].sort() };
}

/**
 * 从叶子格子构造全部层级。gwpKg 为 kg/气体 -> kg CO2e 的点积系数。
 */
export function buildRollup(leafCells: AggCell[], gwp: Record<Gas, Decimal>): RollupRow[] {
  const rows: RollupRow[] = [];

  const emit = (
    level: RollupLevel,
    cells: AggCell[],
    plantId: string | null,
    sourceId: string | null,
    month: string | null,
    scope: Scope,
  ): void => {
    const inScope = cells.filter((c) => c.scope === scope);
    if (inScope.length === 0) return;
    const { kg, recordIds } = sumCells(inScope);
    const kgCo2e = GASES.reduce((acc, g) => acc.plus(kg[g].mul(gwp[g])), new Decimal(0));
    rows.push({
      level,
      plantId,
      sourceId,
      month,
      year: month ? month.slice(0, 4) : null,
      scope,
      kg: { CO2: kg.CO2.toString(), CH4: kg.CH4.toString(), N2O: kg.N2O.toString() },
      kgCo2e: kgCo2e.toString(),
      tonnesCo2e: kgCo2e.div(1000).toString(),
      recordIds,
    });
  };

  const plants = [...new Set(leafCells.map((c) => c.plantId))].sort() as string[];
  const months = [...new Set(leafCells.map((c) => c.month))].sort() as string[];
  const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort();
  const scopes = [Scope.SCOPE_1, Scope.SCOPE_2];

  for (const scope of scopes) {
    // source 叶子
    for (const c of leafCells) emit('source', [c], c.plantId, c.sourceId, c.month, scope);

    // plant × month
    for (const plant of plants) {
      for (const month of months) {
        const cs = leafCells.filter((c) => c.plantId === plant && c.month === month);
        emit('plant', cs, plant, null, month, scope);
      }
    }

    // company × month
    for (const month of months) {
      const cs = leafCells.filter((c) => c.month === month);
      emit('company', cs, null, null, month, scope);
    }

    // plant × year
    for (const plant of plants) {
      for (const year of years) {
        const cs = leafCells.filter((c) => c.plantId === plant && c.month!.startsWith(year));
        emit('plant-year', cs, plant, null, null, scope);
      }
    }

    // company × year
    for (const year of years) {
      const cs = leafCells.filter((c) => c.month!.startsWith(year));
      emit('company-year', cs, null, null, null, scope);
    }
  }

  return rows;
}

/** 全公司全期总量（t CO2e），三气体逐项 */
export function grandTotal(
  leafCells: AggCell[],
  gwp: Record<Gas, Decimal>,
): { kg: Record<Gas, Decimal>; kgCo2e: Decimal; tonnesCo2e: Decimal } {
  const { kg } = sumCells(leafCells);
  const kgCo2e = GASES.reduce((acc, g) => acc.plus(kg[g].mul(gwp[g])), new Decimal(0));
  return { kg, kgCo2e, tonnesCo2e: kgCo2e.div(1000) };
}
