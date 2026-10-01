import { Injectable } from '@nestjs/common';
import { Decimal } from '../common/decimal';
import { AccountingEngine } from '../accounting/accounting.engine';
import { buildRollup, RollupRow } from '../accounting/rollup';
import { Gas } from '../factors/entities';
import { sha256 } from '../common/hash';

export interface QueryCaliber {
  activitySeq?: number | 'latest';
  factorVersionId: string;
  gwpSetId: string;
}

export interface SummaryReport {
  caliber: { activitySeq: number; factorVersionId: string; gwpSetId: string };
  factorLabel: string;
  gwpLabel: string;
  gwpValues: Record<Gas, string>;
  /** 全部层级行（company/plant/source/年/月 × 范围） */
  rows: RollupRow[];
  /** 公司全期总量 */
  total: { scope1TonnesCo2e: string; scope2TonnesCo2e: string; totalTonnesCo2e: string };
  /** 内容指纹：只含口径坐标与全部结果数字，不含时间戳 */
  resultHash: string;
  computedAt: string;
}

/**
 * 查询服务：按口径现算（读穿）。
 *
 * 物化策略的取舍（见 docs/design.md）：因子版本、GWP 集合、活动事实均
 * 不可变，因此“现算”是确定性纯函数——同一口径任何时候结果逐位相同，
 * 且必然等于从原始记录全量重算。我们仅对“对外披露快照”做物化（关账），
 * 不对每个口径预聚合，避免多版本下增量更新的一致性复杂度。
 * resultHash 让调用方可以直接核对两次查询是否逐位一致。
 */
@Injectable()
export class QueryService {
  constructor(private readonly engine: AccountingEngine) {}

  async query(raw: QueryCaliber): Promise<SummaryReport> {
    const caliber = await this.engine.resolveCaliber({
      activitySeq: raw.activitySeq ?? 'latest',
      factorVersionId: raw.factorVersionId,
      gwpSetId: raw.gwpSetId,
    });
    const computed = await this.engine.compute(caliber);
    const leafCells = computed.aggregator.leafCells();
    const rows = buildRollup(leafCells, computed.gwp);

    const scope1 = rows.filter((r) => r.level === 'company-year' && r.scope === 1);
    const scope2 = rows.filter((r) => r.level === 'company-year' && r.scope === 2);
    const sum = (list: RollupRow[]) =>
      list.reduce((acc, r) => acc.plus(r.kgCo2e), new Decimal(0));
    const s1 = sum(scope1).div(1000);
    const s2 = sum(scope2).div(1000);

    // 指纹只覆盖数据本身（口径 + 每行数字与归属），不含计算时间
    const resultHash = sha256({
      caliber,
      gwpValues: Object.fromEntries(Object.entries(computed.gwp).map(([k, v]) => [k, v.toString()])),
      rows: rows.map((r) => ({
        level: r.level,
        plantId: r.plantId,
        sourceId: r.sourceId,
        month: r.month,
        year: r.year,
        scope: r.scope,
        kg: r.kg,
        kgCo2e: r.kgCo2e,
      })),
    });

    return {
      caliber,
      factorLabel: computed.factorLabel,
      gwpLabel: computed.gwpLabel,
      gwpValues: {
        CO2: computed.gwp.CO2.toString(),
        CH4: computed.gwp.CH4.toString(),
        N2O: computed.gwp.N2O.toString(),
      },
      rows,
      total: {
        scope1TonnesCo2e: s1.toString(),
        scope2TonnesCo2e: s2.toString(),
        totalTonnesCo2e: s1.plus(s2).toString(),
      },
      resultHash,
      computedAt: new Date().toISOString(),
    };
  }
}
