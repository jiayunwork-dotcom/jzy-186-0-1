import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Decimal } from '../common/decimal';
import { AccountingEngine } from '../accounting/accounting.engine';
import { buildRollup, grandTotal } from '../accounting/rollup';
import { BaseYearFlag, ClosureSnapshot } from './entities';
import { DATA_STORE } from '../persistence/tokens';
import { Store } from '../persistence/store.interface';
import { ConfigService } from '../config/config.service';
import { sha256 } from '../common/hash';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { monthsOfYear } from '../common/month';
import { Gas, GASES, Scope } from '../factors/entities';
import { AggCell } from '../accounting/aggregation';

function scopeTonnes(cells: AggCell[], scope: Scope, gwp: Record<Gas, Decimal>): string {
  let kg = new Decimal(0);
  for (const c of cells) {
    if (c.scope !== scope) continue;
    for (const g of GASES) kg = kg.plus(c.kg[g].mul(gwp[g]));
  }
  return kg.div(1000).toString();
}

export interface CloseMonthRequest {
  month: string;
  /** 省略或 null = 公司全厂区合并关账 */
  plantId?: string | null;
  factorVersionId: string;
  gwpSetId: string;
  /** 显著性阈值覆盖（默认取配置 5%） */
  threshold?: number | string;
}

export interface CloseMonthResult {
  snapshot: ClosureSnapshot;
  /** 若触发基准年重算，返回说明记录 */
  baseYearFlag: BaseYearFlag | null;
}

/**
 * 月度关账。
 *
 * 显式操作：进入写临界区的第一刻把活动数据截止点钉为当时最大序号；
 * 关账进行中任何因子发布/活动更正都被挡在临界区外，结果只认开始那一刻。
 * 快照不可变，重复关账同厂同月返回 409。
 */
@Injectable()
export class ClosureService {
  constructor(
    @Inject(DATA_STORE) private readonly store: Store,
    private readonly engine: AccountingEngine,
    private readonly config: ConfigService,
  ) {}

  async closeMonth(req: CloseMonthRequest): Promise<CloseMonthResult> {
    if (!req || typeof req !== 'object') throw new ValidationError('request', '关账请求必须是对象');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.month ?? '')) {
      throw new ValidationError('month', '月份必须是 YYYY-MM');
    }
    if (!req.factorVersionId) throw new ValidationError('factorVersionId', '不能为空');
    if (!req.gwpSetId) throw new ValidationError('gwpSetId', '不能为空');
    const plantId = req.plantId === undefined ? null : req.plantId;

    return this.store.withWriteLock(async () => {
      // —— 关账开始这一刻：钉死三个坐标 ——
      const activitySeq = await this.store.getMaxSeq();
      const caliber = {
        activitySeq,
        factorVersionId: req.factorVersionId,
        gwpSetId: req.gwpSetId,
      };

      // 重复关账保护（锁内复查，避免并发双关）
      const existing = await this.store.findClosure(plantId, req.month);
      if (existing) {
        throw new ConflictError(
          `厂区 ${plantId ?? '(全公司)'} 的 ${req.month} 已关账（快照 ${existing.id}），快照不可变`,
        );
      }

      // —— 在锁定坐标下全量核算 ——
      // 关账口径是显式指定的对外披露口径，允许用后发布的新版因子回溯
      // 历史月份（基准年重述披露正是这种情形）；因子版本不可变、追溯可查。
      const computed = await this.engine.compute(caliber, { strictPeriod: false });
      const leafCells = computed.aggregator.leafCells();
      const rows = buildRollup(leafCells, computed.gwp);

      // 快照结果只放该厂月（company 快照放全部厂）
      const scopedCells = leafCells.filter(
        (c) => c.month === req.month && (plantId === null || c.plantId === plantId),
      );
      const scopedTotal = grandTotal(scopedCells, computed.gwp);

      const resultPayload = {
        caliber,
        month: req.month,
        plantId,
        rows: rows.filter(
          (r) => r.month === req.month && (plantId === null || r.plantId === plantId),
        ),
        monthTotalTonnesCo2e: scopedTotal.tonnesCo2e.toString(),
        scope: {
          [Scope.SCOPE_1]: scopeTonnes(scopedCells, Scope.SCOPE_1, computed.gwp),
          [Scope.SCOPE_2]: scopeTonnes(scopedCells, Scope.SCOPE_2, computed.gwp),
        },
      };
      const resultHash = sha256(resultPayload);

      const snapshot: ClosureSnapshot = {
        id: `closure-${req.month}-${plantId ?? 'company'}-${randomUUID().slice(0, 8)}`,
        plantId,
        month: req.month,
        activitySeq,
        factorVersionId: req.factorVersionId,
        gwpSetId: req.gwpSetId,
        resultHash,
        result: resultPayload,
        closedAt: new Date().toISOString(),
      };
      await this.store.insertClosure(snapshot);

      // —— 基准年显著性检查（仅当关账月份属于基准年） ——
      let baseYearFlag: BaseYearFlag | null = null;
      if (req.month.startsWith(this.config.baseYear)) {
        baseYearFlag = await this.evaluateBaseYear(caliber, snapshot, req.threshold);
      }

      return { snapshot, baseYearFlag };
    });
  }

  /**
   * 基准年重算规则：
   * 用本口径重算基准年 12 个月合计，与“基准年最近一次对外快照口径”
   * （没有则以本次为首个基准，不触发）比较；变化率绝对值 > 阈值
   * （默认 5%）时把基准年标记为需重算并落一条说明记录。
   */
  private async evaluateBaseYear(
    caliber: { activitySeq: number; factorVersionId: string; gwpSetId: string },
    snapshot: ClosureSnapshot,
    thresholdOverride?: number | string,
  ): Promise<BaseYearFlag | null> {
    const baseYear = this.config.baseYear;

    // 参照：基准年已有关账快照（任意厂区/月份），取其中最早的一组坐标作为基准口径。
    const prior = (await this.store.listClosures())
      .filter((c) => c.month.startsWith(baseYear))
      .sort((a, b) => a.closedAt.localeCompare(b.closedAt));
    const reference = prior[0];

    const restatedComputed = await this.engine.compute(caliber, { strictPeriod: false });
    const baseCells = restatedComputed.aggregator
      .leafCells()
      .filter((c) => monthsOfYear(baseYear).includes(c.month!));
    const restatedTotal = grandTotal(baseCells, restatedComputed.gwp).tonnesCo2e;

    let baselineTotal: Decimal;
    let referenceClosureId: string | null = null;
    if (reference) {
      const refComputed = await this.engine.compute(
        {
          activitySeq: reference.activitySeq,
          factorVersionId: reference.factorVersionId,
          gwpSetId: reference.gwpSetId,
        },
        { strictPeriod: false },
      );
      const refCells = refComputed.aggregator
        .leafCells()
        .filter((c) => monthsOfYear(baseYear).includes(c.month!));
      baselineTotal = grandTotal(refCells, refComputed.gwp).tonnesCo2e;
      referenceClosureId = reference.id;
    } else {
      // 第一次建立基准年口径，本身不是“重述”，不触发标记
      return null;
    }

    let ratio: Decimal;
    if (baselineTotal.isZero()) {
      ratio = restatedTotal.isZero() ? new Decimal(0) : new Decimal(Infinity);
    } else {
      ratio = restatedTotal.minus(baselineTotal).div(baselineTotal);
    }

    const threshold = new Decimal(
      thresholdOverride !== undefined ? String(thresholdOverride) : String(this.config.significanceThreshold),
    );
    if (!ratio.isFinite() || ratio.abs().lessThanOrEqualTo(threshold)) {
      return null;
    }

    const flag: BaseYearFlag = {
      id: `byf-${baseYear}-${randomUUID().slice(0, 8)}`,
      baseYear,
      triggeredAt: new Date().toISOString(),
      factorVersionId: caliber.factorVersionId,
      gwpSetId: caliber.gwpSetId,
      activitySeq: caliber.activitySeq,
      referenceClosureId,
      baselineTotalTonnesCo2e: baselineTotal.toString(),
      restatedTotalTonnesCo2e: restatedTotal.toString(),
      changeRatio: ratio.toString(),
      threshold: threshold.toString(),
      note:
        `基准年 ${baseYear} 重算后总排放为 ${restatedTotal.toFixed(6)} tCO2e，` +
        `相对参照口径（快照 ${referenceClosureId ?? 'n/a'}，${baselineTotal.toFixed(6)} tCO2e）` +
        `变化 ${ratio.mul(100).toFixed(4)}%，绝对值超过显著性阈值 ${threshold.mul(100).toFixed(2)}%，` +
        `基准年需重算。触发关账快照：${snapshot.id}。`,
    };
    await this.store.upsertBaseYearFlag(flag);
    return flag;
  }

  async getSnapshot(id: string): Promise<ClosureSnapshot> {
    const s = await this.store.getClosure(id);
    if (!s) throw new NotFoundError(`关账快照 ${id} 不存在`);
    return s;
  }

  async findSnapshot(plantId: string | null, month: string): Promise<ClosureSnapshot | null> {
    return this.store.findClosure(plantId, month);
  }

  async listSnapshots(filter?: { plantId?: string; month?: string }): Promise<ClosureSnapshot[]> {
    return this.store.listClosures(filter);
  }

  async getBaseYearFlag(baseYear?: string): Promise<BaseYearFlag | null> {
    return this.store.getBaseYearFlag(baseYear ?? this.config.baseYear);
  }
}
