import { INestApplication } from '@nestjs/common';
import { createApp } from '../../test/harness';
import { factorDraft, GWP_AR5 } from '../../test/fixtures';
import { FactorService } from '../factors/factor.service';
import { FactorRowType, Scope } from '../factors/entities';
import { ConflictError, ValidationError } from '../common/errors';

describe('因子库：版本适用期间、重叠校验、GWP 发布', () => {
  let app: INestApplication;
  let factors: FactorService;

  beforeEach(async () => {
    app = await createApp();
    factors = app.get(FactorService);
  });
  afterEach(() => app.close());

  test('适用期间重叠 -> 字段级错误，指向 effectiveStart', async () => {
    await factors.publishFactorVersion(factorDraft('v1', '2024-01', '2024-07'));
    await expect(factors.publishFactorVersion(factorDraft('v2', '2024-04', null))).rejects.toMatchObject({
      field: 'effectiveStart',
    });
  });

  test('首尾相接（前版结束月 = 新版开始月）不重叠，允许发布', async () => {
    await factors.publishFactorVersion(factorDraft('v1', '2024-01', '2024-07'));
    const v2 = await factors.publishFactorVersion(factorDraft('v2', '2024-07', null));
    expect(v2.effectiveStart).toBe('2024-07');
  });

  test('重复发布同 id 版本 -> 冲突（不可变）', async () => {
    await factors.publishFactorVersion(factorDraft('v1', '2024-01', null));
    await expect(factors.publishFactorVersion(factorDraft('v1', '2025-01', null))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test('结束月早于开始月 -> 校验错误', async () => {
    await expect(factors.publishFactorVersion(factorDraft('v1', '2024-07', '2024-01'))).rejects.toMatchObject({
      field: 'effectiveEnd',
    });
  });

  test('因子单位无法解析 -> rows[i].unit 字段错误', async () => {
    const d = factorDraft('v1', '2024-01', null);
    d.rows[0] = { ...d.rows[0], unit: 'kg/frobnicate' };
    await expect(factors.publishFactorVersion(d)).rejects.toMatchObject({ field: 'rows[0].unit' });
  });

  test('排放因子缺 gas/scope -> 字段错误', async () => {
    const d = factorDraft('v1', '2024-01', null);
    d.rows[0] = {
      fuelOrActivity: 'x',
      type: FactorRowType.EMISSION,
      value: '1',
      unit: 'kg/GJ',
      // 故意缺 gas/scope
    } as never;
    await expect(factors.publishFactorVersion(d)).rejects.toMatchObject({ field: 'rows[0].gas' });
  });

  test('密度行携带 gas 被拒绝；数值非有限被拒绝', async () => {
    const d = factorDraft('v1', '2024-01', null);
    d.rows.push({
      fuelOrActivity: 'diesel',
      type: FactorRowType.DENSITY,
      gas: 'CO2', // 密度不允许 gas
      value: '800',
      unit: 'kg/m3',
    } as never);
    await expect(factors.publishFactorVersion(d)).rejects.toMatchObject({ field: 'rows[9].type' });

    const d2 = factorDraft('v2', '2024-01', null);
    d2.rows.push({
      fuelOrActivity: 'diesel',
      type: FactorRowType.DENSITY,
      value: 'Infinity',
      unit: 'kg/m3',
    });
    await expect(factors.publishFactorVersion(d2)).rejects.toBeInstanceOf(ValidationError);
  });

  test('GWP：CO2 必须为 1、三气体齐全、重复 id 冲突', async () => {
    const bad = { id: 'g1', label: 'g', values: [{ gas: 'CO2', value: '2' }, { gas: 'CH4', value: '28' }, { gas: 'N2O', value: '265' }] };
    await expect(factors.publishGwpSet(bad as never)).rejects.toMatchObject({ field: 'values' });
    const missing = {
      id: 'g2',
      label: 'g',
      values: [
        { gas: 'CO2', value: '1' },
        { gas: 'CH4', value: '28' },
      ],
    };
    await expect(factors.publishGwpSet(missing as never)).rejects.toMatchObject({ field: 'values' });
    await factors.publishGwpSet(GWP_AR5);
    await expect(factors.publishGwpSet(GWP_AR5)).rejects.toBeInstanceOf(ConflictError);
  });

  test('scope 取值非法被拒绝', async () => {
    const d = factorDraft('v1', '2024-01', null);
    d.rows[0] = { ...d.rows[0], scope: 3 as Scope };
    await expect(factors.publishFactorVersion(d)).rejects.toMatchObject({ field: 'rows[0].scope' });
  });
});
