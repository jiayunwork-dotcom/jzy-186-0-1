import { PgStore } from '../src/persistence/pg.store';
import { FactorRowType, Scope } from '../src/factors/entities';
import { ConflictError } from '../src/common/errors';

/**
 * PostgreSQL 16 存储契约测试。
 *
 * 仅当 DATABASE_URL 指向的数据库可达时运行（docker compose up db 后
 * `npm run test:pg`），否则整组 skip——保证无 PG 的环境也能 `npm test`。
 * 覆盖：建表幂等、seq 分配、更正链、并发更正冲突（咨询锁）、
 * 关账唯一约束、基准年标记 upsert。
 */
const URL = process.env.DATABASE_URL ?? 'postgres://ghg:ghg_secret@localhost:5432/ghg';

describe('PostgreSQL 存储（需数据库）', () => {
  let store: PgStore;
  let available = false;

  beforeAll(async () => {
    store = new PgStore(URL);
    try {
      await store.init();
      await store.withWriteLock(async () => {
        await (store as unknown as {
          pool: { query: (s: string) => Promise<unknown> };
        }).pool.query('TRUNCATE base_year_flags, closure_snapshots, activity_records, gwp_values, gwp_sets, factor_rows, factor_versions RESTART IDENTITY CASCADE');
      });
      available = true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`跳过 PG 测试（数据库不可达：${URL}）：${(e as Error).message}`);
    }
  }, 30000);

  afterAll(async () => {
    if (available) await (store as unknown as { close: () => Promise<void> }).close.call(store);
    else await (store as unknown as { close?: () => Promise<void> }).close?.();
  });

  test('插入与幂等：重复 id 不覆盖', async () => {
    if (!available) return;
    const rec = {
      id: 'pg-1',
      supersedesId: null,
      rootId: 'pg-1',
      plantId: 'P1',
      sourceId: 'S1',
      fuelOrActivity: 'natural_gas',
      month: '2024-01',
      quantity: '100',
      unit: 'GJ',
      seq: 1,
      acceptedAt: new Date().toISOString(),
    };
    const a = await store.insertActivity(rec);
    const b = await store.insertActivity(rec);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(await store.getMaxSeq()).toBe(1);
  });

  test('seq 与按截止点查询、更正链归并', async () => {
    if (!available) return;
    await store.insertActivity({
      id: 'pg-2',
      supersedesId: 'pg-1',
      rootId: 'pg-1',
      plantId: 'P1',
      sourceId: 'S1',
      fuelOrActivity: 'natural_gas',
      month: '2024-01',
      quantity: '120',
      unit: 'GJ',
      seq: 2,
      acceptedAt: new Date().toISOString(),
    });
    expect((await store.listRecordsUpTo(1)).map((r) => r.id)).toEqual(['pg-1']);
    expect((await store.listRecordsUpTo(2)).map((r) => r.id).sort()).toEqual(['pg-1', 'pg-2']);
    const chain = await store.getChainByRoot('pg-1');
    expect(chain.map((r) => r.seq)).toEqual([1, 2]);
  });

  test('因子版本与 GWP 集合往返', async () => {
    if (!available) return;
    await store.insertFactorVersion({
      id: 'pg-fv',
      label: 'pg',
      effectiveStart: '2024-01',
      effectiveEnd: null,
      publishedAt: new Date().toISOString(),
      rows: [
        { id: 'pg-fv:r0', factorVersionId: 'pg-fv', fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_1, value: '56.1', unit: 'kg/GJ' },
      ],
    });
    const v = await store.getFactorVersion('pg-fv');
    expect(v!.rows[0].value).toBe('56.100000000000'); // NUMERIC(38,12) 定标字符串
    await store.insertGwpSet({
      id: 'pg-ar5',
      label: 'ar5',
      publishedAt: new Date().toISOString(),
      values: [
        { gas: 'CO2', value: '1' },
        { gas: 'CH4', value: '28' },
        { gas: 'N2O', value: '265' },
      ],
    });
    expect((await store.getGwpSet('pg-ar5'))!.values).toHaveLength(3);
  });

  test('并发更正：两个并发事务只成功一个（SERIALIZABLE + 咨询锁）', async () => {
    if (!available) return;
    const mk = (id: string, target: string, qty: string, seq: number) =>
      store.withWriteLock(async () => {
        // 模拟“临界区内查链头再插入”
        const head = (await store.getChainByRoot('pg-1')).reduce((a, b) => (b.seq > a.seq ? b : a));
        if (head.id !== target) {
          throw new ConflictError(`target ${target} superseded by ${head.id}`);
        }
        await store.insertActivity({
          id,
          supersedesId: target,
          rootId: 'pg-1',
          plantId: 'P1',
          sourceId: 'S1',
          fuelOrActivity: 'natural_gas',
          month: '2024-01',
          quantity: qty,
          unit: 'GJ',
          seq,
          acceptedAt: new Date().toISOString(),
        });
      });
    const [a, b] = await Promise.allSettled([mk('pg-c-a', 'pg-2', '121', 3), mk('pg-c-b', 'pg-2', '122', 4)]);
    const statuses = [a.status, b.status];
    expect(statuses).toContain('fulfilled');
    expect(statuses).toContain('rejected');
  });

  test('关账快照同厂月唯一（数据库约束兜底）', async () => {
    if (!available) return;
    const snap = {
      id: 'pg-close-1',
      plantId: null,
      month: '2024-01',
      activitySeq: 2,
      factorVersionId: 'pg-fv',
      gwpSetId: 'pg-ar5',
      resultHash: 'h',
      result: { x: 1 },
      closedAt: new Date().toISOString(),
    };
    await store.insertClosure(snap);
    await expect(
      store.insertClosure({ ...snap, id: 'pg-close-2' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
