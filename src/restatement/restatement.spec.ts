import { INestApplication } from '@nestjs/common';
import Decimal from 'decimal.js';
import { createApp } from '../../test/harness';
import { factorDraft, GWP_AR5, GWP_AR6 } from '../../test/fixtures';
import { FactorService } from '../factors/factor.service';
import { ActivityService } from '../activity/activity.service';
import { RestatementService } from '../restatement/restatement.service';
import { QueryService } from '../query/query.service';
import { FactorRowType, Scope } from '../factors/entities';
import { FactorVersionDraft } from '../factors/store.interface';

/** 因子 CO2 系数从 56.1 改为 59.466（+6%），适用期 2025 起（重述可回溯） */
function newFactorDraft(): FactorVersionDraft {
  return {
    id: 'fv-new',
    label: 'fv-new',
    effectiveStart: '2025-01',
    effectiveEnd: null,
    rows: [
      { fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_1, value: '59.466', unit: 'kg/GJ' },
      { fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'CH4', scope: Scope.SCOPE_1, value: '0.001', unit: 'kg/GJ' },
      { fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'N2O', scope: Scope.SCOPE_1, value: '0.0001', unit: 'kg/GJ' },
      { fuelOrActivity: 'diesel', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_1, value: '2.68', unit: 'kg/L' },
      { fuelOrActivity: 'diesel', type: FactorRowType.EMISSION, gas: 'CH4', scope: Scope.SCOPE_1, value: '0.0001', unit: 'kg/L' },
      { fuelOrActivity: 'diesel', type: FactorRowType.EMISSION, gas: 'N2O', scope: Scope.SCOPE_1, value: '0.00002', unit: 'kg/L' },
      { fuelOrActivity: 'grid_electricity', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_2, value: '0.5', unit: 'kg/kWh' },
      { fuelOrActivity: 'grid_electricity', type: FactorRowType.EMISSION, gas: 'CH4', scope: Scope.SCOPE_2, value: '0', unit: 'kg/kWh' },
      { fuelOrActivity: 'grid_electricity', type: FactorRowType.EMISSION, gas: 'N2O', scope: Scope.SCOPE_2, value: '0', unit: 'kg/kWh' },
    ],
  };
}

async function seed(app: INestApplication): Promise<void> {
  const factors = app.get(FactorService);
  await factors.publishFactorVersion(factorDraft('fv-old', '2024-01', '2025-01'));
  await factors.publishFactorVersion(newFactorDraft());
  await factors.publishGwpSet(GWP_AR5);
  await factors.publishGwpSet(GWP_AR6);
  const activity = app.get(ActivityService);
  await activity.importBatch([
    { id: 'a1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' },
  ]);
}

const cal = (factorVersionId: string, gwpSetId: string, activitySeq: number | 'latest' = 'latest') => ({
  activitySeq,
  factorVersionId,
  gwpSetId,
});

describe('重述与 Shapley 差额分解', () => {
  let app: INestApplication;
  let restate: RestatementService;
  let activity: ActivityService;
  let query: QueryService;

  beforeEach(async () => {
    app = await createApp();
    await seed(app);
    restate = app.get(RestatementService);
    activity = app.get(ActivityService);
    query = app.get(QueryService);
  });
  afterEach(() => app.close());

  test('三因素同时变化：三部分之和严格等于总差额（残差为 0）', async () => {
    // A: 旧因子 + AR5 + 初始活动；之后补报活动量 100 -> 106（+6%）
    // B: 新因子(+6%) + AR6 + 更正后的活动
    await activity.correct({ correctionId: 'a1-corr', targetId: 'a1', quantity: 106, unit: 'GJ' });

    const d = await restate.restate(cal('fv-old', 'ar5', 1), cal('fv-new', 'ar6'));
    expect(new Decimal(d.residualKgCo2e).equals(0)).toBe(true);
    const partsSum = d.parts.reduce((a, p) => a.plus(p.kgCo2e), new Decimal(0));
    expect(partsSum.equals(new Decimal(d.total.kgCo2e))).toBe(true);
    expect(['activity', 'factor', 'gwp'].sort()).toEqual(d.parts.map((p) => p.factor).sort());
    // 三因素都为正贡献（本例都是上调）
    for (const p of d.parts) expect(new Decimal(p.kgCo2e).greaterThan(0)).toBe(true);
  });

  test('只换 GWP 集合：CO2 物理排放量不变，总差仅来自 CH4/N2O 折算', async () => {
    const q5 = await query.query(cal('fv-old', 'ar5', 1));
    const q6 = await query.query(cal('fv-old', 'ar6', 1));
    const leaf5 = q5.rows.find((r) => r.level === 'source')!;
    const leaf6 = q6.rows.find((r) => r.level === 'source')!;
    expect(leaf6.kg.CO2).toBe(leaf5.kg.CO2); // CO2 kg 完全不变
    expect(leaf6.kg.CH4).toBe(leaf5.kg.CH4); // CH4/N2O 物理质量也不变
    expect(new Decimal(leaf6.kgCo2e).greaterThan(leaf5.kgCo2e)).toBe(true); // 但 CO2e 变大

    // 分解中：gwp 部分的分气体“质量变化”恒为 0（GWP 不改物理量）
    const d = await restate.restate(cal('fv-old', 'ar5', 1), cal('fv-old', 'ar6', 1));
    const gwpPart = d.parts.find((p) => p.factor === 'gwp')!;
    expect(gwpPart.kgByGas.CO2).toBe('0');
    expect(gwpPart.kgByGas.CH4).toBe('0');
    expect(gwpPart.kgByGas.N2O).toBe('0');
    const actPart = d.parts.find((p) => p.factor === 'activity')!;
    const facPart = d.parts.find((p) => p.factor === 'factor')!;
    expect(new Decimal(actPart.kgCo2e).equals(0)).toBe(true);
    expect(new Decimal(facPart.kgCo2e).equals(0)).toBe(true);
    expect(new Decimal(d.total.kgCo2e).equals(new Decimal(gwpPart.kgCo2e))).toBe(true);
  });

  test('只换因子版本：全部差额归因子，活动与潜势部分为 0', async () => {
    const d = await restate.restate(cal('fv-old', 'ar5', 1), cal('fv-new', 'ar5', 1));
    const factor = d.parts.find((p) => p.factor === 'factor')!;
    expect(new Decimal(factor.kgCo2e).equals(new Decimal(d.total.kgCo2e))).toBe(true);
    // CO2 差额 = 100 GJ × (59.466 - 56.1) = 336.6 kg
    expect(factor.kgByGas.CO2).toBe('336.6');
  });

  test('只补报活动数据：全部差额归活动，因子与潜势部分为 0', async () => {
    await activity.correct({ correctionId: 'a1-corr', targetId: 'a1', quantity: 106, unit: 'GJ' });
    const d = await restate.restate(cal('fv-old', 'ar5', 1), cal('fv-old', 'ar5'));
    const act = d.parts.find((p) => p.factor === 'activity')!;
    expect(new Decimal(act.kgCo2e).equals(new Decimal(d.total.kgCo2e))).toBe(true);
    // CO2 差额 = (106 - 100) × 56.1 = 336.6 kg
    expect(act.kgByGas.CO2).toBe('336.6');
  });

  test('协同项被对称分配：activity 与 factor 的 Shapley 贡献各为固定顺序两端的平均', async () => {
    // 100 -> 106，56.1 -> 59.466。固定顺序 A 先 F 后时：
    //   activity 部分 = 6×56.1 = 336.6
    //   factor 部分   = 106×3.366 = 356.796
    // 固定顺序 F 先 A 后时：
    //   factor 部分   = 100×3.366 = 336.6
    //   activity 部分 = 6×59.466 = 356.796
    // Shapley（顺序平均）：两部分都 = (336.6 + 356.796)/2 = 346.698
    await activity.correct({ correctionId: 'a1-corr', targetId: 'a1', quantity: 106, unit: 'GJ' });
    const d = await restate.restate(cal('fv-old', 'ar5', 1), cal('fv-new', 'ar5'));
    const act = d.parts.find((p) => p.factor === 'activity')!;
    const fac = d.parts.find((p) => p.factor === 'factor')!;
    // 只看 CO2 部分（CH4/N2O 也随同样结构变化，故断言 CO2 即可）
    expect(act.kgByGas.CO2).toBe('346.698');
    expect(fac.kgByGas.CO2).toBe('346.698');
    // 协同项 6×3.366 = 20.196 被对半分：各得 10.098
    expect(new Decimal(act.kgByGas.CO2).minus(336.6).toString()).toBe('10.098');
    expect(new Decimal(fac.kgByGas.CO2).minus(336.6).toString()).toBe('10.098');
  });

  test('层级过滤：差额可在厂区/年份/范围任意层级分解且配平', async () => {
    await activity.correct({ correctionId: 'a1-corr', targetId: 'a1', quantity: 106, unit: 'GJ' });
    const d = await restate.restate(cal('fv-old', 'ar5', 1), cal('fv-new', 'ar6'), {
      plantId: 'P1',
      year: 2024,
      scope: 1,
    });
    expect(new Decimal(d.residualKgCo2e).equals(0)).toBe(true);
    expect(d.level).toContain('plant=P1');
    expect(d.level).toContain('scope=1');
  });
});
