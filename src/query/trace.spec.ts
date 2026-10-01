import { INestApplication } from '@nestjs/common';
import Decimal from 'decimal.js';
import { createApp } from '../../test/harness';
import { factorDraft, GWP_AR5 } from '../../test/fixtures';
import { FactorService } from '../factors/factor.service';
import { ActivityService } from '../activity/activity.service';
import { TraceService } from '../query/trace.service';
import { QueryService } from '../query/query.service';
import { ValidationError } from '../common/errors';

async function seed(app: INestApplication): Promise<void> {
  const factors = app.get(FactorService);
  await factors.publishFactorVersion(factorDraft('fv-2024', '2024-01', null));
  await factors.publishGwpSet(GWP_AR5);
  const activity = app.get(ActivityService);
  await activity.importBatch([
    { id: 'r1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' },
    { id: 'r2', plantId: 'P1', sourceId: 'S2', fuelOrActivity: 'diesel', month: '2024-01', quantity: 1000, unit: 'L' },
  ]);
  // 对 r1 发起更正，验证追溯显示整条链并标出生效版本
  await activity.correct({ correctionId: 'r1-c1', targetId: 'r1', quantity: 110, unit: 'GJ' });
}

describe('追溯查询', () => {
  let app: INestApplication;
  let trace: TraceService;
  let query: QueryService;

  beforeEach(async () => {
    app = await createApp();
    await seed(app);
    trace = app.get(TraceService);
    query = app.get(QueryService);
  });
  afterEach(() => app.close());

  test('追溯清单逐条列出原始记录、因子行与 GWP；合计等于汇总数字', async () => {
    const caliber = { factorVersionId: 'fv-2024', gwpSetId: 'ar5' };
    const t = await trace.trace(caliber, { plantId: 'P1', month: '2024-01', scope: 1 });
    const summary = await query.query(caliber);
    const leaf = summary.rows.find(
      (r) => r.level === 'plant' && r.plantId === 'P1' && r.month === '2024-01' && r.scope === 1,
    )!;

    expect(t.contributions).toHaveLength(2);
    expect(new Decimal(t.totalKgCo2e).equals(leaf.kgCo2e)).toBe(true);

    const gasRecord = t.contributions.find((c) => c.record.fuelOrActivity === 'natural_gas')!;
    // 生效的是更正记录 r1-c1，链含 r1 与 r1-c1
    expect(gasRecord.record.id).toBe('r1-c1');
    expect(gasRecord.record.quantity).toBe('110');
    expect(gasRecord.chain.map((c) => c.id)).toEqual(['r1', 'r1-c1']);
    expect(gasRecord.chain.find((c) => c.id === 'r1')!.active).toBe(false);
    expect(gasRecord.chain.find((c) => c.id === 'r1-c1')!.active).toBe(true);

    // CO2 行：因子 56.1 kg/GJ × 110 GJ = 6171 kg
    const co2 = gasRecord.gases.find((g) => g.gas === 'CO2')!;
    expect(co2.factorValue).toBe('56.1');
    expect(co2.factorUnit).toBe('kg/GJ');
    expect(co2.kg).toBe('6171');
    expect(co2.gwp).toBe('1');
    // 折算后活动量与换算路径
    expect(gasRecord.baseActivityAmount).toBe('110');
    expect(gasRecord.conversionPath).toContain('110 GJ');
  });

  test('按排放源过滤追溯', async () => {
    const t = await trace.trace({ factorVersionId: 'fv-2024', gwpSetId: 'ar5' }, { sourceId: 'S2' });
    expect(t.contributions).toHaveLength(1);
    expect(t.contributions[0].record.fuelOrActivity).toBe('diesel');
    // 柴油 CO2: 1000 L × 2.68 = 2680 kg
    expect(t.contributions[0].gases.find((g) => g.gas === 'CO2')!.kg).toBe('2680');
  });

  test('单位无法换算到因子要求的单位时：查询抛出指向具体记录的字段级错误', async () => {
    // 天然气因子分母是能量 kg/GJ，再导入一条以体积 m3 计量、
    // 而因子版本没有 ncvVolume 的记录，无法换算
    const activity = app.get(ActivityService);
    await activity.importBatch([
      { id: 'r3', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'm3' },
    ]);
    await expect(
      query.query({ factorVersionId: 'fv-2024', gwpSetId: 'ar5' }),
    ).rejects.toBeInstanceOf(ValidationError);
    try {
      await query.query({ factorVersionId: 'fv-2024', gwpSetId: 'ar5' });
      fail('应抛错');
    } catch (e) {
      const ve = e as ValidationError;
      expect(ve.field).toBe('unit');
      expect(ve.message).toContain('r3');
      expect(ve.details).toMatchObject({ recordId: 'r3', missingParam: 'ncvVolume' });
    }
  });

  test('月份不在因子适用期间：正常披露口径（strict）拒绝并指出 month', async () => {
    // 重新构造一个有期间限制的版本
    const app2 = await createApp();
    const factors = app2.get(FactorService);
    await factors.publishFactorVersion(factorDraft('fv-h1', '2024-01', '2024-07'));
    await factors.publishGwpSet(GWP_AR5);
    const activity = app2.get(ActivityService);
    await activity.importBatch([
      { id: 'x1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-09', quantity: 10, unit: 'GJ' },
    ]);
    const q = app2.get(QueryService);
    await expect(q.query({ factorVersionId: 'fv-h1', gwpSetId: 'ar5' })).rejects.toMatchObject({
      field: 'month',
    });
    await app2.close();
  });
});
