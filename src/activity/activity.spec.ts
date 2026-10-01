import { INestApplication } from '@nestjs/common';
import { createApp } from '../../test/harness';
import { factorDraft, GWP_AR5 } from '../../test/fixtures';
import { FactorService } from '../factors/factor.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, ValidationError } from '../common/errors';

describe('活动数据：批量导入、幂等、更正链、并发更正', () => {
  let app: INestApplication;
  let activity: ActivityService;

  beforeEach(async () => {
    app = await createApp();
    const factors = app.get(FactorService);
    await factors.publishFactorVersion(factorDraft('fv-2024', '2024-01', null));
    await factors.publishGwpSet(GWP_AR5);
    activity = app.get(ActivityService);
  });
  afterEach(() => app.close());

  test('批量导入逐条回报：非法记录不影响其余', async () => {
    const report = await activity.importBatch([
      { id: 'ok1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 10, unit: 'GJ' },
      { id: 'bad1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: -5, unit: 'GJ' },
      { id: 'ok2', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 20, unit: 'GJ' },
      // 非有限数（字符串内容非法，运行时校验）
      { id: 'bad2', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 'NaN', unit: 'GJ' },
      // 月份格式错（运行时校验）
      { id: 'bad3', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024/01', quantity: 1, unit: 'GJ' },
    ]);
    expect(report.results.map((r) => r.id).sort()).toEqual(['ok1', 'ok2']);
    const failedFields = Object.fromEntries(report.failures.map((f) => [f.id, f.field]));
    expect(failedFields).toMatchObject({ bad1: 'quantity', bad2: 'quantity', bad3: 'month' });
    // 序号只分给成功记录
    expect(report.results.map((r) => r.seq)).toEqual([1, 2]);
  });

  test('重复提交同一编号不产生重复计数（幂等）', async () => {
    const item = { id: 'dup', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 10, unit: 'GJ' };
    const r1 = await activity.importBatch([item]);
    const r2 = await activity.importBatch([item]);
    expect(r1.results[0]).toMatchObject({ id: 'dup', status: 'created' });
    expect(r2.results[0]).toMatchObject({ id: 'dup', status: 'duplicate', seq: 1 });
    const active = await activity.getActiveRecords(999);
    expect(active.filter((r) => r.rootId === 'dup')).toHaveLength(1);
  });

  test('同编号内容不同则拒绝，不覆盖既有记录', async () => {
    await activity.importBatch([
      { id: 'x', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 10, unit: 'GJ' },
    ]);
    const r = await activity.importBatch([
      { id: 'x', plantId: 'P1', sourceId: 'S9', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 11, unit: 'GJ' },
    ]);
    expect(r.failures[0]).toMatchObject({ id: 'x', field: 'id' });
    const rec = await activity.getRecord('x');
    expect(rec.sourceId).toBe('S1');
    expect(rec.quantity).toBe('10');
  });

  test('更正产生新编号记录并指向旧记录，原记录保留，截止点前取旧值', async () => {
    await activity.importBatch([
      { id: 'orig', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 10, unit: 'GJ' },
    ]);
    const c = await activity.correct({ correctionId: 'corr1', targetId: 'orig', quantity: 12, unit: 'GJ' });
    expect(c.status).toBe('created');
    expect(c.record.supersedesId).toBe('orig');
    expect(c.record.rootId).toBe('orig');

    // 截止 seq=1（更正前）取原值
    const before = await activity.getActiveRecords(1);
    expect(before.find((r) => r.rootId === 'orig')!.quantity).toBe('10');
    // 最新取更正值
    const after = await activity.getActiveRecords(999);
    expect(after.find((r) => r.rootId === 'orig')!.id).toBe('corr1');
    expect(after.find((r) => r.rootId === 'orig')!.quantity).toBe('12');

    // 原始记录仍可查询
    const orig = await activity.getRecord('orig');
    expect(orig.quantity).toBe('10');
  });

  test('更正指向不存在的记录 -> 字段级错误', async () => {
    await expect(
      activity.correct({ correctionId: 'c', targetId: 'ghost', quantity: 1, unit: 'GJ' }),
    ).rejects.toMatchObject({ field: 'targetId' });
  });

  test('对已被更正的记录再次更正 -> 冲突', async () => {
    await activity.importBatch([
      { id: 'o', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 10, unit: 'GJ' },
    ]);
    await activity.correct({ correctionId: 'c1', targetId: 'o', quantity: 11, unit: 'GJ' });
    await expect(
      activity.correct({ correctionId: 'c2', targetId: 'o', quantity: 12, unit: 'GJ' }),
    ).rejects.toBeInstanceOf(ConflictError);
    // 但可以更正当前生效记录 c1（链条逐代延续）
    const c3 = await activity.correct({ correctionId: 'c3', targetId: 'c1', quantity: 13, unit: 'GJ' });
    expect(c3.record.supersedesId).toBe('c1');
  });

  test('两个并发更正同时提交，只接受一个，另一个冲突', async () => {
    await activity.importBatch([
      { id: 'hot', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 10, unit: 'GJ' },
    ]);
    const [a, b] = await Promise.allSettled([
      activity.correct({ correctionId: 'cc-a', targetId: 'hot', quantity: 11, unit: 'GJ' }),
      activity.correct({ correctionId: 'cc-b', targetId: 'hot', quantity: 12, unit: 'GJ' }),
    ]);
    const statuses = [a, b].map((r) => r.status);
    expect(statuses).toContain('fulfilled');
    expect(statuses).toContain('rejected');
    const rejected = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    // 生效链头只有一个
    const active = await activity.getActiveRecords(999);
    const chain = active.filter((r) => r.rootId === 'hot');
    expect(chain).toHaveLength(1);
  });

  test('重复提交同一更正编号幂等返回，不产生第二条', async () => {
    await activity.importBatch([
      { id: 'p', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 10, unit: 'GJ' },
    ]);
    const req = { correctionId: 'pc', targetId: 'p', quantity: 11, unit: 'GJ' };
    const r1 = await activity.correct(req);
    const r2 = await activity.correct(req);
    expect(r1.status).toBe('created');
    expect(r2.status).toBe('duplicate');
    expect(r2.record.id).toBe('pc');
  });

  test('更正数量为负 -> 字段级 ValidationError', async () => {
    await activity.importBatch([
      { id: 'n', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 10, unit: 'GJ' },
    ]);
    await expect(
      activity.correct({ correctionId: 'nc', targetId: 'n', quantity: -1, unit: 'GJ' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
