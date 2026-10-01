import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../test/harness';
import { factorDraft, GWP_AR5, GWP_AR6 } from '../test/fixtures';
import { FactorService } from './factors/factor.service';

describe('HTTP 端到端', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeEach(async () => {
    app = await createApp();
    const factors = app.get(FactorService);
    await factors.publishFactorVersion(factorDraft('fv-2024', '2024-01', null));
    await factors.publishGwpSet(GWP_AR5);
    await factors.publishGwpSet(GWP_AR6);
    server = app.getHttpServer();
  });
  afterEach(() => app.close());

  test('批量导入逐条回报，非法记录 422 批内隔离（HTTP 207 风格：200 + results/failures）', async () => {
    const res = await request(server)
      .post('/activities/import')
      .send({
        items: [
          { id: 'a', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' },
          { id: 'b', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: -1, unit: 'GJ' },
        ],
      })
      .expect(201);
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual(['a']);
    expect(res.body.failures[0]).toMatchObject({ id: 'b', field: 'quantity' });
  });

  test('导入幂等：重复编号第二次返回 duplicate', async () => {
    const payload = {
      items: [{ id: 'a', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' }],
    };
    await request(server).post('/activities/import').send(payload).expect(201);
    const res2 = await request(server).post('/activities/import').send(payload).expect(201);
    expect(res2.body.results[0].status).toBe('duplicate');
  });

  test('并发更正：一个 201，一个 409', async () => {
    await request(server)
      .post('/activities/import')
      .send({
        items: [{ id: 'h', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' }],
      });
    const [r1, r2] = await Promise.all([
      request(server).post('/activities/correct').send({ correctionId: 'h1', targetId: 'h', quantity: 101, unit: 'GJ' }),
      request(server).post('/activities/correct').send({ correctionId: 'h2', targetId: 'h', quantity: 102, unit: 'GJ' }),
    ]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([201, 409]);
  });

  test('更正指向不存在记录 -> 422 + field=targetId', async () => {
    const res = await request(server)
      .post('/activities/correct')
      .send({ correctionId: 'c', targetId: 'nope', quantity: 1, unit: 'GJ' })
      .expect(422);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', field: 'targetId' });
  });

  test('发布因子版本：成功与适用期间重叠 422', async () => {
    // 选 2020 年窗口，避开 beforeEach 已发布的开放版本 fv-2024
    const res = await request(server)
      .post('/factor-versions')
      .send(factorDraft('fv-x', '2020-01', '2020-07'))
      .expect(201);
    expect(res.body.id).toBe('fv-x');
    const overlap = await request(server)
      .post('/factor-versions')
      .send(factorDraft('fv-y', '2020-04', null))
      .expect(422);
    expect(overlap.body.error.field).toBe('effectiveStart');
  });

  test('按口径查询汇总：返回层级行、范围一/二总量与指纹', async () => {
    await request(server)
      .post('/activities/import')
      .send({
        items: [
          { id: 'g1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' },
          { id: 'e1', plantId: 'P2', sourceId: 'S3', fuelOrActivity: 'grid_electricity', month: '2024-01', quantity: 1000, unit: 'kWh' },
        ],
      });
    const res = await request(server)
      .post('/query/summary')
      .send({ caliber: { factorVersionId: 'fv-2024', gwpSetId: 'ar5' } })
      .expect(201);
    expect(res.body.resultHash).toEqual(expect.any(String));
    expect(res.body.caliber).toMatchObject({ factorVersionId: 'fv-2024', gwpSetId: 'ar5' });
    expect(res.body.total.scope2TonnesCo2e).toBe('0.5');
  });

  test('两口径对比返回三部分分解，残差为 0', async () => {
    await request(server)
      .post('/activities/import')
      .send({
        items: [{ id: 'g1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' }],
      });
    const res = await request(server)
      .post('/restatements/compare')
      .send({
        caliberA: { activitySeq: 1, factorVersionId: 'fv-2024', gwpSetId: 'ar5' },
        caliberB: { activitySeq: 1, factorVersionId: 'fv-2024', gwpSetId: 'ar6' },
      })
      .expect(201);
    expect(res.body.residualKgCo2e).toBe('0');
    expect(res.body.parts).toHaveLength(3);
  });

  test('关账与快照查询：快照之后的更正不影响结果', async () => {
    await request(server)
      .post('/activities/import')
      .send({
        items: [{ id: 'g1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' }],
      });
    const closed = await request(server)
      .post('/closures')
      .send({ month: '2024-01', factorVersionId: 'fv-2024', gwpSetId: 'ar5' })
      .expect(201);
    const id = closed.body.snapshot.id;
    await request(server)
      .post('/activities/correct')
      .send({ correctionId: 'g1-c', targetId: 'g1', quantity: 9999, unit: 'GJ' });
    const snap = await request(server).get(`/closures/${id}`).expect(200);
    expect(snap.body.result.monthTotalTonnesCo2e).toBe(closed.body.snapshot.result.monthTotalTonnesCo2e);
    // 重复关账 409
    await request(server)
      .post('/closures')
      .send({ month: '2024-01', factorVersionId: 'fv-2024', gwpSetId: 'ar5' })
      .expect(409);
  });

  test('追溯接口返回原始记录与因子', async () => {
    await request(server)
      .post('/activities/import')
      .send({
        items: [{ id: 'g1', plantId: 'P1', sourceId: 'S1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' }],
      });
    const res = await request(server)
      .post('/query/trace')
      .send({ caliber: { factorVersionId: 'fv-2024', gwpSetId: 'ar5' }, filter: { sourceId: 'S1' } })
      .expect(201);
    expect(res.body.contributions[0].record.id).toBe('g1');
    const co2 = res.body.contributions[0].gases.find((x: { gas: string }) => x.gas === 'CO2');
    expect(co2.factorValue).toBe('56.1');
    expect(co2.factorUnit).toBe('kg/GJ');
    expect(co2.kg).toBe('5610');
  });
});
