import { INestApplication } from '@nestjs/common';
import { createApp } from '../../test/harness';
import { factorDraft, GWP_AR5, GWP_AR6 } from '../../test/fixtures';
import { FactorService } from '../factors/factor.service';
import { ActivityService } from '../activity/activity.service';
import { QueryService } from '../query/query.service';
import { ImportItem } from '../activity/entities';
import Decimal from 'decimal.js';

async function seed(app: INestApplication): Promise<void> {
  const factors = app.get(FactorService);
  await factors.publishFactorVersion(factorDraft('fv-2024', '2024-01', null));
  await factors.publishGwpSet(GWP_AR5);
  await factors.publishGwpSet(GWP_AR6);

  const activity = app.get(ActivityService);
  const items: ImportItem[] = [
    // 厂 P1 锅炉 S1 天然气 100 GJ（5.61 t CO2）
    { id: 'r1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' },
    // 厂 P1 锅炉 S1 二月 200 GJ
    { id: 'r2', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-02', quantity: 200, unit: 'GJ' },
    // 厂 P1 车队 S2 柴油 1000 L
    { id: 'r3', plantId: 'P1', sourceId: 'S2', fuelOrActivity: 'diesel', month: '2024-01', quantity: 1000, unit: 'L' },
    // 厂 P2 外购电 5000 kWh（范围二）
    { id: 'r4', plantId: 'P2', sourceId: 'S3', fuelOrActivity: 'grid_electricity', month: '2024-01', quantity: 5000, unit: 'kWh' },
  ];
  const report = await activity.importBatch(items);
  expect(report.failures).toEqual([]);
}

describe('核算引擎：5.61t 算例与层级加总', () => {
  let app: INestApplication;
  let query: QueryService;

  beforeEach(async () => {
    app = await createApp();
    await seed(app);
    query = app.get(QueryService);
  });
  afterEach(() => app.close());

  test('100 GJ × 56.1 kg/GJ = 5610 kg = 5.61 t CO2', async () => {
    const rep = await query.query({ factorVersionId: 'fv-2024', gwpSetId: 'ar5' });
    const leaf = rep.rows.find(
      (r) => r.level === 'source' && r.plantId === 'P1' && r.sourceId === 'S1' && r.month === '2024-01' && r.scope === 1,
    )!;
    expect(leaf).toBeDefined();
    expect(leaf.kg.CO2).toBe('5610');
    expect(leaf.tonnesCo2e.startsWith('5.61')).toBe(true); // CO2 GWP=1，CH4/N2O 使 CO2e 略大
    // CO2 恰为 5.61 t
    expect(new Decimal(leaf.kg.CO2).div(1000).toString()).toBe('5.61');
  });

  test('厂区合计 = 各排放源之和；年合计 = 各月之和；公司 = 各厂区', async () => {
    const rep = await query.query({ factorVersionId: 'fv-2024', gwpSetId: 'ar5' });
    const D = require('decimal.js');

    const sumRows = (pred: (r: (typeof rep.rows)[number]) => boolean, key: 'kgCo2e') =>
      rep.rows.filter(pred).reduce((a: any, r: any) => new D(a).plus(r[key]), new D(0));

    // 厂区 P1 × 2024-01 = 该月各排放源之和
    const plantMonth = rep.rows.find((r) => r.level === 'plant' && r.plantId === 'P1' && r.month === '2024-01' && r.scope === 1)!;
    const sourcesMonth = sumRows(
      (r) => r.level === 'source' && r.plantId === 'P1' && r.month === '2024-01' && r.scope === 1,
      'kgCo2e',
    );
    expect(new D(plantMonth.kgCo2e).equals(sourcesMonth)).toBe(true);

    // P1 年合计 = 1、2 两月之和
    const plantYear = rep.rows.find((r) => r.level === 'plant-year' && r.plantId === 'P1' && r.scope === 1)!;
    const monthsSum = sumRows(
      (r) => r.level === 'plant' && r.plantId === 'P1' && r.scope === 1,
      'kgCo2e',
    );
    expect(new D(plantYear.kgCo2e).equals(monthsSum)).toBe(true);

    // 公司年 = 两厂区年之和（注意范围二在 P2）
    const companyYear1 = rep.rows.find((r) => r.level === 'company-year' && r.scope === 1)!;
    const plantsYear1 = sumRows((r) => r.level === 'plant-year' && r.scope === 1, 'kgCo2e');
    expect(new D(companyYear1.kgCo2e).equals(plantsYear1)).toBe(true);

    const companyYear2 = rep.rows.find((r) => r.level === 'company-year' && r.scope === 2)!;
    const plantsYear2 = sumRows((r) => r.level === 'plant-year' && r.scope === 2, 'kgCo2e');
    expect(new D(companyYear2.kgCo2e).equals(plantsYear2)).toBe(true);

    // 总量 = 范围一 + 范围二
    const grand = new D(rep.total.totalTonnesCo2e);
    expect(grand.equals(new D(rep.total.scope1TonnesCo2e).plus(rep.total.scope2TonnesCo2e))).toBe(true);
  });

  test('同一口径重复计算结果逐位相同（resultHash 与全部数字）', async () => {
    const a = await query.query({ factorVersionId: 'fv-2024', gwpSetId: 'ar5' });
    const b = await query.query({ factorVersionId: 'fv-2024', gwpSetId: 'ar5' });
    expect(b.resultHash).toBe(a.resultHash);
    expect(JSON.stringify(b.rows)).toBe(JSON.stringify(a.rows));
    expect(b.total).toEqual(a.total);
    // 显式指定截止点也一致
    const c = await query.query({ activitySeq: 4, factorVersionId: 'fv-2024', gwpSetId: 'ar5' });
    expect(c.resultHash).toBe(a.resultHash);
  });

  test('范围一与范围二分别汇总：天然气/柴油在 S1，外购电在 S2', async () => {
    const rep = await query.query({ factorVersionId: 'fv-2024', gwpSetId: 'ar5' });
    expect(new Decimal(rep.total.scope2TonnesCo2e).toString()).toBe('2.5'); // 5000 kWh × 0.5 kg/kWh = 2500 kg
    expect(new Decimal(rep.total.scope1TonnesCo2e).greaterThan(5.61)).toBe(true);
  });
});
