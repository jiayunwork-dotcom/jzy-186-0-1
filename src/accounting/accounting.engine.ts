import { Inject, Injectable } from '@nestjs/common';
import { DATA_STORE } from '../persistence/tokens';
import { Store } from '../persistence/store.interface';
import { FactorService } from '../factors/factor.service';
import { ActivityService } from '../activity/activity.service';
import { FactorIndex } from './factor-index';
import { computeRecord, RecordEmission } from './compute-record';
import { Aggregator, AggregationResult, Caliber } from './aggregation';
import { Decimal } from '../common/decimal';
import { Gas } from '../factors/entities';

/** 引擎内部结果（保留 Decimal，供分解模块直接做线性代数） */
export interface EngineResult {
  caliber: Caliber;
  index: FactorIndex;
  gwp: Record<Gas, Decimal>;
  gwpLabel: string;
  factorLabel: string;
  /** 每条生效记录的排放明细（顺序确定，供追溯与分解） */
  recordEmissions: RecordEmission[];
  aggregator: Aggregator;
}

/**
 * 核算引擎。纯函数式核心：给定“口径三元组”与数据，结果唯一确定。
 * 不缓存、不物化任何会变化的中间结果；每次都从（不可变的）原始记录 +
 * （不可变的）因子版本 +（不可变的）GWP 集合重算，
 * 因此“同一口径任何时候查出来的数字完全相同，且与全量重算一致”由构造保证。
 */
@Injectable()
export class AccountingEngine {
  constructor(
    @Inject(DATA_STORE) readonly store: Store,
    private readonly factors: FactorService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * 按口径全量核算。
   * @param caliber.activitySeq 必须是已解析的具体序号
   * @param opts.strictPeriod
   *   true（默认）：月份必须落在因子版本适用期间内，用于正常披露/关账；
   *   false：允许显式指定的口径跨期回溯（重述对比专用——用新版因子重算
   *   历史月份正是重述的目的，适用期间是自动选版的约束，不是回溯禁令）。
   */
  async compute(
    caliber: Caliber,
    opts: { strictPeriod?: boolean } = {},
  ): Promise<EngineResult> {
    const [version, gwpSet] = await Promise.all([
      this.factors.getFactorVersion(caliber.factorVersionId),
      this.factors.getGwpSet(caliber.gwpSetId),
    ]);
    const index = new FactorIndex(version);
    const gwp: Record<Gas, Decimal> = {
      CO2: new Decimal(0),
      CH4: new Decimal(0),
      N2O: new Decimal(0),
    };
    for (const v of gwpSet.values) gwp[v.gas] = new Decimal(v.value);

    const active = await this.activity.getActiveRecords(caliber.activitySeq);
    const aggregator = new Aggregator();
    // 记录按 id 排序后再算，保证任何集合下输出顺序（含 JSON 序列化结果）确定
    const ordered = [...active].sort((a, b) =>
      a.plantId.localeCompare(b.plantId) ||
      a.sourceId.localeCompare(b.sourceId) ||
      a.month.localeCompare(b.month) ||
      a.id.localeCompare(b.id),
    );
    const recordEmissions = ordered.map((rec) => {
      const em = computeRecord(rec, index, { strictPeriod: opts.strictPeriod ?? true });
      aggregator.add(em);
      return em;
    });

    return {
      caliber,
      index,
      gwp,
      gwpLabel: gwpSet.label,
      factorLabel: version.label,
      recordEmissions,
      aggregator,
    };
  }

  /** 便捷：把 'latest' 解析成具体序号 */
  async resolveCaliber(c: { activitySeq: number | 'latest'; factorVersionId: string; gwpSetId: string }): Promise<Caliber> {
    const seq = await this.activity.resolveSeq(c.activitySeq);
    return { activitySeq: seq, factorVersionId: c.factorVersionId, gwpSetId: c.gwpSetId };
  }
}

export type { AggregationResult };
