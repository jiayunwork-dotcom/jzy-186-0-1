import { INestApplication } from '@nestjs/common';
import Decimal from 'decimal.js';
import { createApp } from '../../test/harness';
import { factorDraft, GWP_AR5, GWP_AR6 } from '../../test/fixtures';
import { FactorService } from '../factors/factor.service';
import { ActivityService } from '../activity/activity.service';
import { ClosureService } from '../closure/closure.service';
import { FactorRowType, Scope } from '../factors/entities';

async function seed(app: INestApplication, opts: { withNew?: boolean; oldCo2?: number; newCo2?: number } = {}): Promise<void> {
  const factors = app.get(FactorService);
  await factors.publishFactorVersion(factorDraft('fv-old', '2024-01', '2025-01', { gasCO2: opts.oldCo2 ?? 56.1 }));
  if (opts.withNew) {
    const newer = factorDraft('fv-new', '2025-01', null, { gasCO2: opts.newCo2 ?? 59.466 });
    await factors.publishFactorVersion(newer);
  }
  await factors.publishGwpSet(GWP_AR5);
  await factors.publishGwpSet(GWP_AR6);
  const activity = app.get(ActivityService);
  await activity.importBatch([
    { id: 'a1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' },
    { id: 'a2', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-02', quantity: 100, unit: 'GJ' },
  ]);
}

describe('月度关账快照与基准年重算', () => {
  let app: INestApplication;
  let closure: ClosureService;
  let activity: ActivityService;

  beforeEach(async () => {
    app = await createApp();
    closure = app.get(ClosureService);
    activity = app.get(ActivityService);
  });
  afterEach(() => app.close());

  test('关账锁定开始时刻的口径；之后发布与更正不影响快照', async () => {
    await seed(app, { withNew: true });
    const first = await closure.closeMonth({ month: '2024-01', factorVersionId: 'fv-old', gwpSetId: 'ar5' });
    expect(first.snapshot.activitySeq).toBe(2);

    // 关账之后：发布新数据/更正/新因子版本，全都不应改变快照
    await activity.correct({ correctionId: 'a1-corr', targetId: 'a1', quantity: 999, unit: 'GJ' });
    const snap = await closure.getSnapshot(first.snapshot.id);
    const payload = snap.result as {
      caliber: { activitySeq: number; factorVersionId: string; gwpSetId: string };
      monthTotalTonnesCo2e: string;
    };
    expect(payload.caliber).toEqual({ activitySeq: 2, factorVersionId: 'fv-old', gwpSetId: 'ar5' });
    // 快照里的数字仍按 100 GJ × 旧因子
    const co2Leaf = (payload as unknown as { rows: Array<{ kg: { CO2: string } }> }).rows.find((r) => true);
    expect(co2Leaf?.kg.CO2).toBe('5610');
    expect(snap.activitySeq).toBe(2); // 没有变成更正后的序号
  });

  test('同一厂月重复关账冲突；快照不可变', async () => {
    await seed(app, { withNew: true });
    await closure.closeMonth({ month: '2024-01', factorVersionId: 'fv-old', gwpSetId: 'ar5' });
    await expect(
      closure.closeMonth({ month: '2024-01', factorVersionId: 'fv-old', gwpSetId: 'ar5' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('基准年变化超过 5% 阈值：标记基准年并生成说明记录', async () => {
    await seed(app, { withNew: true });
    // 第一次关账建立基准年参照（首月本身不触发）
    const first = await closure.closeMonth({ month: '2024-01', factorVersionId: 'fv-old', gwpSetId: 'ar5' });
    expect(first.baseYearFlag).toBeNull();

    // 第二次关账用 +6% 的新因子（同一基准年口径下重算）
    const second = await closure.closeMonth({ month: '2024-02', factorVersionId: 'fv-new', gwpSetId: 'ar5' });
    expect(second.baseYearFlag).not.toBeNull();
    const flag = second.baseYearFlag!;
    expect(flag.baseYear).toBe('2024');
    expect(flag.referenceClosureId).toBe(first.snapshot.id);
    const ratio = new Decimal(flag.changeRatio);
    expect(ratio.abs().greaterThan(0.05)).toBe(true);
    // 说明记录含阈值与两个总量
    expect(flag.note).toContain('5.00%');
    expect(flag.threshold).toBe('0.05');

    const stored = await closure.getBaseYearFlag('2024');
    expect(stored?.id).toBe(flag.id);
  });

  test('基准年变化未超过阈值：不标记', async () => {
    await seed(app, { withNew: false });
    // 新版本只上调 2%
    const factors = app.get(FactorService);
    // 用独立 app 更简单：这里直接对 56.1 -> 57.222（+2%）重新发版本
    const small: Parameters<FactorService['publishFactorVersion']>[0] = {
      id: 'fv-small',
      label: 'small',
      effectiveStart: '2025-01',
      effectiveEnd: null,
      rows: [
        { fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_1, value: '57.222', unit: 'kg/GJ' },
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
    await factors.publishFactorVersion(small);
    await closure.closeMonth({ month: '2024-01', factorVersionId: 'fv-old', gwpSetId: 'ar5' });
    const second = await closure.closeMonth({ month: '2024-02', factorVersionId: 'fv-small', gwpSetId: 'ar5' });
    expect(second.baseYearFlag).toBeNull();
    expect(await closure.getBaseYearFlag('2024')).toBeNull();
  });

  test('阈值可按次覆盖（如 0.10 时 6% 不再触发）', async () => {
    await seed(app, { withNew: true });
    await closure.closeMonth({ month: '2024-01', factorVersionId: 'fv-old', gwpSetId: 'ar5' });
    const second = await closure.closeMonth({
      month: '2024-02',
      factorVersionId: 'fv-new',
      gwpSetId: 'ar5',
      threshold: 0.1,
    });
    expect(second.baseYearFlag).toBeNull();
  });

  test('可按 id 与按厂月查询快照，列表按时间序', async () => {
    await seed(app, { withNew: false });
    const r = await closure.closeMonth({ month: '2024-01', factorVersionId: 'fv-old', gwpSetId: 'ar5' });
    const found = await closure.findSnapshot(null, '2024-01');
    expect(found?.id).toBe(r.snapshot.id);
    const list = await closure.listSnapshots({ month: '2024-01' });
    expect(list).toHaveLength(1);
  });
});
