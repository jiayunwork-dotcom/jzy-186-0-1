import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from '../common/decimal';
import { AccountingEngine } from '../accounting/accounting.engine';
import { CellFilter, CellFilterSpec } from '../restatement/cell-filter';
import { Gas, GASES } from '../factors/entities';
import { DATA_STORE } from '../persistence/tokens';
import { Store } from '../persistence/store.interface';

export interface TraceContribution {
  record: {
    id: string;
    supersedesId: string | null;
    rootId: string;
    plantId: string;
    sourceId: string;
    fuelOrActivity: string;
    month: string;
    quantity: string;
    unit: string;
    seq: number;
  };
  /** 该业务事实的完整更正链，active 标出本口径下生效的一条 */
  chain: Array<{
    id: string;
    supersedesId: string | null;
    quantity: string;
    unit: string;
    seq: number;
    active: boolean;
  }>;
  baseActivityAmount: string;
  baseActivityUnit: string;
  conversionPath: string;
  gases: Array<{
    gas: Gas;
    factorRowId: string;
    factorValue: string;
    factorUnit: string;
    kg: string;
    gwp: string;
    kgCo2e: string;
  }>;
  conversionFactors: Array<{ factorRowId: string; kind: string; value: string; unit: string }>;
}

export interface TraceResult {
  caliber: { activitySeq: number; factorVersionId: string; gwpSetId: string };
  level: string;
  filter: CellFilterSpec;
  totalKgCo2e: string;
  totalTonnesCo2e: string;
  contributions: TraceContribution[];
}

/**
 * 追溯查询：任意一条汇总数字，由哪些原始活动记录（含更正链上生效的版本）、
 * 排放因子、密度/热值、GWP 值得出。
 * 与查询接口共用同一引擎现算，追溯清单之和必然等于被追溯数字。
 */
@Injectable()
export class TraceService {
  constructor(
    private readonly engine: AccountingEngine,
    @Inject(DATA_STORE) private readonly store: Store,
  ) {}

  async trace(
    rawCaliber: { activitySeq?: number | 'latest'; factorVersionId: string; gwpSetId: string },
    filterSpec: CellFilterSpec = {},
  ): Promise<TraceResult> {
    const caliber = await this.engine.resolveCaliber({
      activitySeq: rawCaliber.activitySeq ?? 'latest',
      factorVersionId: rawCaliber.factorVersionId,
      gwpSetId: rawCaliber.gwpSetId,
    });
    const computed = await this.engine.compute(caliber);

    const matches = (em: (typeof computed.recordEmissions)[number]): boolean => {
      const s = filterSpec;
      if (s.plantId !== undefined && s.plantId !== null && em.plantId !== s.plantId) return false;
      if (s.sourceId !== undefined && em.sourceId !== s.sourceId) return false;
      if (s.month !== undefined && em.month !== s.month) return false;
      if (s.year !== undefined && em.month.slice(0, 4) !== String(s.year)) return false;
      if (s.scope !== undefined && em.scope !== s.scope) return false;
      return true;
    };
    const matched = computed.recordEmissions.filter(matches);

    // 批量取更正链，避免 N+1
    const rootIds = [...new Set(matched.map((m) => m.rootId))];
    const chainRows = rootIds.length ? await this.store.getChainsByRoots(rootIds) : [];
    const chainByRoot = new Map(rootIds.map((r) => [r, [] as (typeof chainRows)[number][]]));
    for (const c of chainRows) chainByRoot.get(c.rootId)!.push(c);

    const gwpStr: Record<Gas, string> = {
      CO2: computed.gwp.CO2.toString(),
      CH4: computed.gwp.CH4.toString(),
      N2O: computed.gwp.N2O.toString(),
    };

    const contributions: TraceContribution[] = [];
    let totalKgCo2e = new Decimal(0);
    for (const em of matched) {
      let recKgCo2e = new Decimal(0);
      const gases = GASES.map((gas) => {
        const row = em.factorRowsUsed.find((r) => r.gas === gas)!;
        const kg = em.kgByGas[gas];
        const co2e = kg.mul(computed.gwp[gas]);
        recKgCo2e = recKgCo2e.plus(co2e);
        return {
          gas,
          factorRowId: row.factorRowId,
          factorValue: row.value,
          factorUnit: row.unit,
          kg: kg.toString(),
          gwp: gwpStr[gas],
          kgCo2e: co2e.toString(),
        };
      });
      totalKgCo2e = totalKgCo2e.plus(recKgCo2e);

      const chain = (chainByRoot.get(em.rootId) ?? [])
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((c) => ({
          id: c.id,
          supersedesId: c.supersedesId,
          quantity: c.quantity,
          unit: c.unit,
          seq: c.seq,
          active: c.id === em.recordId,
        }));
      const rec = em.sourceRecord;

      contributions.push({
        record: {
          id: rec.id,
          supersedesId: rec.supersedesId,
          rootId: rec.rootId,
          plantId: rec.plantId,
          sourceId: rec.sourceId,
          fuelOrActivity: rec.fuelOrActivity,
          month: rec.month,
          quantity: rec.quantity,
          unit: rec.unit,
          seq: rec.seq,
        },
        chain,
        baseActivityAmount: em.baseActivityAmount,
        baseActivityUnit: em.baseActivityUnit,
        conversionPath: em.conversionPath,
        gases,
        conversionFactors: em.conversionRowsUsed.map((c) => ({
          factorRowId: c.factorRowId,
          kind: c.kind,
          value: c.value,
          unit: c.unit,
        })),
      });
    }

    return {
      caliber,
      level: CellFilter.describe(filterSpec),
      filter: filterSpec,
      totalKgCo2e: totalKgCo2e.toString(),
      totalTonnesCo2e: totalKgCo2e.div(1000).toString(),
      contributions,
    };
  }
}
