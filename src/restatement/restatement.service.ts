import { Injectable } from '@nestjs/common';
import { AccountingEngine } from '../accounting/accounting.engine';
import { Caliber } from '../accounting/aggregation';
import { CellFilter, CellFilterSpec } from './cell-filter';
import { decompose, DecompositionResult, Vertex } from './shapley';
import { FactorIndex } from '../accounting/factor-index';

/**
 * 重述服务：把“口径三元组 + 汇总层级”映射到 8 个混合口径的核算，
 * 再调用纯数学的 Shapley 分解。
 *
 * 混合口径的构造：
 *   a=false -> A.activitySeq，a=true  -> B.activitySeq
 *   f=false -> A.factorVersionId，f=true -> B.factorVersionId
 *   g=false -> A.gwpSetId，g=true   -> B.gwpSetId
 * 三个坐标相互独立，引擎按坐标取值，因此可以自由组合。
 */
@Injectable()
export class RestatementService {
  constructor(private readonly engine: AccountingEngine) {}

  async restate(
    caliberARaw: { activitySeq: number | 'latest'; factorVersionId: string; gwpSetId: string },
    caliberBRaw: { activitySeq: number | 'latest'; factorVersionId: string; gwpSetId: string },
    filterSpec: CellFilterSpec = {},
  ): Promise<DecompositionResult> {
    const A = await this.engine.resolveCaliber(caliberARaw);
    const B = await this.engine.resolveCaliber(caliberBRaw);

    // 8 个顶点涉及的因子版本/GWP 集合/截止点都不可变，
    // 可以安全地按需缓存索引，避免重复构建。
    const indexCache = new Map<string, FactorIndex>();
    const evaluator = async (v: Vertex) => {
      const caliber: Caliber = {
        activitySeq: v.a ? B.activitySeq : A.activitySeq,
        factorVersionId: v.f ? B.factorVersionId : A.factorVersionId,
        gwpSetId: v.g ? B.gwpSetId : A.gwpSetId,
      };
      const result = await this.engine.compute(caliber, { strictPeriod: false });
      // 索引与 gwp 已在 result 内，按顶点返回即可
      indexCache.set(caliber.factorVersionId, result.index);
      return {
        leafCells: result.aggregator.leafCells(),
        gwp: result.gwp,
        index: result.index,
      };
    };

    const filter = CellFilter.of(filterSpec);
    return decompose(A, B, evaluator, filter, CellFilter.describe(filterSpec));
  }
}
