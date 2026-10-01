import { Decimal } from '../common/decimal';
import { Gas, GASES, GwpSet, Scope } from '../factors/entities';
import { RecordEmission } from './compute-record';

/**
 * 一个“口径-汇总格子”：厂区/排放源/月份/范围 全限定。
 * 内部以 kg 的高精度 Decimal 保存三种气体质量；
 * CO2e = Σ kgGas × gwp（同一线性运算，严格可加）。
 */
export interface AggCell {
  plantId: string | null; // null = 公司层（跨厂区合计）
  sourceId: string | null; // null = 厂区层（跨排放源合计）
  month: string | null; // null = 年/全期合计
  scope: Scope;
  kg: Record<Gas, Decimal>;
  /** 贡献到本格子的生效记录编号（追溯用） */
  recordIds: string[];
}

export interface Caliber {
  /** 活动数据截止点：具体接受序号（'latest' 在进入引擎前已解析） */
  activitySeq: number;
  factorVersionId: string;
  gwpSetId: string;
}

export interface AggregationResult {
  caliber: Caliber;
  factorLabel: string;
  gwpLabel: string;
  /** 最细粒度格子（plantId/sourceId/month/scope 全有值） */
  leafCells: AggCell[];
  /** 各气体在 GWP 集合下的 GWP 值（追溯展示） */
  gwpValues: Record<Gas, string>;
}

export function cellKey(c: Pick<AggCell, 'plantId' | 'sourceId' | 'month' | 'scope'>): string {
  return `${c.plantId ?? '∅'}|${c.sourceId ?? '∅'}|${c.month ?? '∅'}|${c.scope}`;
}

/** 把单记录排放累加到叶子格子 */
export class Aggregator {
  private cells = new Map<string, AggCell>();

  add(em: RecordEmission): void {
    const key = cellKey({ plantId: em.plantId, sourceId: em.sourceId, month: em.month, scope: em.scope });
    let cell = this.cells.get(key);
    if (!cell) {
      cell = {
        plantId: em.plantId,
        sourceId: em.sourceId,
        month: em.month,
        scope: em.scope,
        kg: { CO2: new Decimal(0), CH4: new Decimal(0), N2O: new Decimal(0) },
        recordIds: [],
      };
      this.cells.set(key, cell);
    }
    for (const g of GASES) cell.kg[g] = cell.kg[g].plus(em.kgByGas[g]);
    cell.recordIds.push(em.recordId);
  }

  leafCells(): AggCell[] {
    return [...this.cells.values()].sort(
      (a, b) =>
        (a.plantId ?? '').localeCompare(b.plantId ?? '') ||
        (a.sourceId ?? '').localeCompare(b.sourceId ?? '') ||
        (a.month ?? '').localeCompare(b.month ?? '') ||
        a.scope - b.scope,
    );
  }
}

/** kg 三气体 -> kg CO2e（线性点积） */
export function kgToCo2e(kg: Record<Gas, Decimal>, gwp: GwpSet): Decimal {
  const byGas = new Map(gwp.values.map((v) => [v.gas, new Decimal(v.value)]));
  let total = new Decimal(0);
  for (const g of GASES) {
    total = total.plus(kg[g].mul(byGas.get(g)!));
  }
  return total;
}
