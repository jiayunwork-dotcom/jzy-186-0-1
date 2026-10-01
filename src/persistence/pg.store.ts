import { Pool, PoolClient } from 'pg';
import { AsyncLocalStorage } from 'async_hooks';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ActivityRecord } from '../activity/entities';
import { FactorRow, FactorVersion, GwpSet, GwpValue } from '../factors/entities';
import { BaseYearFlag, ClosureSnapshot } from '../closure/entities';
import { Store } from './store.interface';
import { ConflictError } from '../common/errors';

/**
 * PostgreSQL 16 存储实现。
 *
 * 并发模型：所有“写 + 关账”都在 withWriteLock 内执行——
 * SERIALIZABLE 事务 + 固定键的 pg_advisory_xact_lock，保证全系统写串行化。
 * 事务内的查询通过 AsyncLocalStorage 复用同一个客户端连接，
 * 因此活动序号分配、链头校验、插入、快照核算在同一事务视图内完成。
 *
 * numeric 列由 node-pg 以字符串返回，应用层 Decimal 精确运算；
 * 不可变事实表只增不改，更正以新行表达。
 */
const WRITE_LOCK_KEY = '7365178042'; // 'ghg' 风格的固定锁键（bigint 范围内）

interface ActivityRow {
  id: string;
  supersedes_id: string | null;
  root_id: string;
  plant_id: string;
  source_id: string;
  fuel_or_activity: string;
  month: string;
  quantity: string;
  unit: string;
  seq: string;
  accepted_at: Date;
}

export class PgStore implements Store {
  private pool: Pool;
  private als = new AsyncLocalStorage<PoolClient>();

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 10 });
  }

  async init(): Promise<void> {
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * 写临界区：可串行化事务 + 咨询锁。回调内对本 store 的所有调用
   * 都在同一连接/事务中执行。
   */
  async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK_KEY]);
      const result = await this.als.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private query(text: string, params?: unknown[]) {
    const client = this.als.getStore();
    return client ? client.query(text, params) : this.pool.query(text, params);
  }

  // ---- 活动数据 ----

  async getById(id: string): Promise<ActivityRecord | null> {
    const r = await this.query('SELECT * FROM activity_records WHERE id = $1', [id]);
    return r.rowCount ? mapActivity(r.rows[0] as ActivityRow) : null;
  }

  async getChainByRoot(rootId: string): Promise<ActivityRecord[]> {
    const r = await this.query(
      'SELECT * FROM activity_records WHERE root_id = $1 ORDER BY seq',
      [rootId],
    );
    return r.rows.map((x) => mapActivity(x as ActivityRow));
  }

  async getChainsByRoots(rootIds: string[]): Promise<ActivityRecord[]> {
    if (rootIds.length === 0) return [];
    const r = await this.query(
      'SELECT * FROM activity_records WHERE root_id = ANY($1) ORDER BY seq',
      [rootIds],
    );
    return r.rows.map((x) => mapActivity(x as ActivityRow));
  }

  async insertActivity(
    rec: ActivityRecord,
  ): Promise<{ inserted: true } | { inserted: false; existing: ActivityRecord }> {
    const r = await this.query(
      `INSERT INTO activity_records
         (id, supersedes_id, root_id, plant_id, source_id, fuel_or_activity, month, quantity, unit, seq, accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [
        rec.id,
        rec.supersedesId,
        rec.rootId,
        rec.plantId,
        rec.sourceId,
        rec.fuelOrActivity,
        rec.month,
        rec.quantity,
        rec.unit,
        rec.seq,
        rec.acceptedAt,
      ],
    );
    if (r.rowCount === 0) {
      const existing = await this.getById(rec.id);
      return { inserted: false, existing: existing! };
    }
    return { inserted: true };
  }

  async getMaxSeq(): Promise<number> {
    const r = await this.query('SELECT COALESCE(MAX(seq), 0) AS m FROM activity_records');
    return Number((r.rows[0] as { m: string }).m);
  }

  async listRecordsUpTo(seq: number): Promise<ActivityRecord[]> {
    const r = await this.query(
      'SELECT * FROM activity_records WHERE seq <= $1 ORDER BY seq',
      [seq],
    );
    return r.rows.map((x) => mapActivity(x as ActivityRow));
  }

  async listAll(filter?: { plantId?: string; month?: string }): Promise<ActivityRecord[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter?.plantId) {
      params.push(filter.plantId);
      conds.push(`plant_id = $${params.length}`);
    }
    if (filter?.month) {
      params.push(filter.month);
      conds.push(`month = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await this.query(`SELECT * FROM activity_records ${where} ORDER BY seq`, params);
    return r.rows.map((x) => mapActivity(x as ActivityRow));
  }

  // ---- 因子库 ----

  async insertFactorVersion(v: FactorVersion): Promise<void> {
    await this.query(
      `INSERT INTO factor_versions (id, label, effective_start, effective_end, published_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [v.id, v.label, v.effectiveStart, v.effectiveEnd, v.publishedAt],
    );
    for (const [i, row] of v.rows.entries()) {
      await this.query(
        `INSERT INTO factor_rows
           (id, factor_version_id, fuel_or_activity, type, gas, scope, value, unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          row.id || `${v.id}:row:${i}`,
          v.id,
          row.fuelOrActivity,
          row.type,
          row.gas ?? null,
          row.scope ?? null,
          row.value,
          row.unit,
        ],
      );
    }
  }

  async getFactorVersion(id: string): Promise<FactorVersion | null> {
    const vr = await this.query('SELECT * FROM factor_versions WHERE id = $1', [id]);
    if (vr.rowCount === 0) return null;
    const rr = await this.query('SELECT * FROM factor_rows WHERE factor_version_id = $1', [id]);
    return mapFactorVersion(vr.rows[0], rr.rows);
  }

  async listFactorVersions(): Promise<FactorVersion[]> {
    const vr = await this.query('SELECT * FROM factor_versions ORDER BY published_at');
    const rr = await this.query('SELECT * FROM factor_rows ORDER BY id');
    return vr.rows.map((v) => mapFactorVersion(v, rr.rows.filter((x) => x.factor_version_id === v.id)));
  }

  async insertGwpSet(g: GwpSet): Promise<void> {
    await this.query('INSERT INTO gwp_sets (id, label, published_at) VALUES ($1,$2,$3)', [
      g.id,
      g.label,
      g.publishedAt,
    ]);
    for (const v of g.values) {
      await this.query('INSERT INTO gwp_values (gwp_set_id, gas, value) VALUES ($1,$2,$3)', [
        g.id,
        v.gas,
        v.value,
      ]);
    }
  }

  async getGwpSet(id: string): Promise<GwpSet | null> {
    const gr = await this.query('SELECT * FROM gwp_sets WHERE id = $1', [id]);
    if (gr.rowCount === 0) return null;
    const vr = await this.query('SELECT * FROM gwp_values WHERE gwp_set_id = $1', [id]);
    return mapGwpSet(gr.rows[0], vr.rows);
  }

  async listGwpSets(): Promise<GwpSet[]> {
    const gr = await this.query('SELECT * FROM gwp_sets ORDER BY published_at');
    const vr = await this.query('SELECT * FROM gwp_values ORDER BY gwp_set_id, gas');
    return gr.rows.map((g) =>
      mapGwpSet(g, vr.rows.filter((x) => x.gwp_set_id === g.id)),
    );
  }

  // ---- 关账与基准年 ----

  async insertClosure(s: ClosureSnapshot): Promise<void> {
    try {
      await this.query(
        `INSERT INTO closure_snapshots
           (id, plant_id, month, activity_seq, factor_version_id, gwp_set_id, result_hash, result, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          s.id,
          s.plantId,
          s.month,
          s.activitySeq,
          s.factorVersionId,
          s.gwpSetId,
          s.resultHash,
          JSON.stringify(s.result),
          s.closedAt,
        ],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictError(`该厂月的关账快照已存在且不可变（${s.plantId ?? '全公司'} ${s.month}）`);
      }
      throw e;
    }
  }

  async getClosure(id: string): Promise<ClosureSnapshot | null> {
    const r = await this.query('SELECT * FROM closure_snapshots WHERE id = $1', [id]);
    return r.rowCount ? mapClosure(r.rows[0]) : null;
  }

  async findClosure(plantId: string | null, month: string): Promise<ClosureSnapshot | null> {
    const r = await this.query(
      'SELECT * FROM closure_snapshots WHERE plant_id IS NOT DISTINCT FROM $1 AND month = $2',
      [plantId, month],
    );
    return r.rowCount ? mapClosure(r.rows[0]) : null;
  }

  async listClosures(filter?: { plantId?: string; month?: string }): Promise<ClosureSnapshot[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter?.plantId) {
      params.push(filter.plantId);
      conds.push(`plant_id = $${params.length}`);
    }
    if (filter?.month) {
      params.push(filter.month);
      conds.push(`month = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await this.query(
      `SELECT * FROM closure_snapshots ${where} ORDER BY month, plant_id`,
      params,
    );
    return r.rows.map(mapClosure);
  }

  async upsertBaseYearFlag(flag: BaseYearFlag): Promise<void> {
    await this.query(
      `INSERT INTO base_year_flags
         (id, base_year, triggered_at, factor_version_id, gwp_set_id, activity_seq,
          reference_closure_id, baseline_total, restated_total, change_ratio, threshold, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (base_year) DO UPDATE SET
         triggered_at = EXCLUDED.triggered_at,
         factor_version_id = EXCLUDED.factor_version_id,
         gwp_set_id = EXCLUDED.gwp_set_id,
         activity_seq = EXCLUDED.activity_seq,
         reference_closure_id = EXCLUDED.reference_closure_id,
         baseline_total = EXCLUDED.baseline_total,
         restated_total = EXCLUDED.restated_total,
         change_ratio = EXCLUDED.change_ratio,
         threshold = EXCLUDED.threshold,
         note = EXCLUDED.note`,
      [
        flag.id,
        flag.baseYear,
        flag.triggeredAt,
        flag.factorVersionId,
        flag.gwpSetId,
        flag.activitySeq,
        flag.referenceClosureId,
        flag.baselineTotalTonnesCo2e,
        flag.restatedTotalTonnesCo2e,
        flag.changeRatio,
        flag.threshold,
        flag.note,
      ],
    );
  }

  async getBaseYearFlag(baseYear: string): Promise<BaseYearFlag | null> {
    const r = await this.query('SELECT * FROM base_year_flags WHERE base_year = $1', [baseYear]);
    return r.rowCount ? mapBaseYearFlag(r.rows[0]) : null;
  }

  async listBaseYearFlags(): Promise<BaseYearFlag[]> {
    const r = await this.query('SELECT * FROM base_year_flags ORDER BY base_year');
    return r.rows.map(mapBaseYearFlag);
  }
}

// ---------- 行映射 ----------

function mapActivity(r: ActivityRow): ActivityRecord {
  return {
    id: r.id,
    supersedesId: r.supersedes_id,
    rootId: r.root_id,
    plantId: r.plant_id,
    sourceId: r.source_id,
    fuelOrActivity: r.fuel_or_activity,
    month: r.month,
    quantity: r.quantity,
    unit: r.unit,
    seq: Number(r.seq),
    acceptedAt: r.accepted_at.toISOString(),
  };
}

function mapFactorVersion(v: Record<string, unknown>, rows: Record<string, unknown>[]): FactorVersion {
  return {
    id: v.id as string,
    label: v.label as string,
    effectiveStart: v.effective_start as string,
    effectiveEnd: (v.effective_end as string | null) ?? null,
    publishedAt: (v.published_at as Date).toISOString(),
    rows: rows.map(
      (r): FactorRow => ({
        id: r.id as string,
        factorVersionId: r.factor_version_id as string,
        fuelOrActivity: r.fuel_or_activity as string,
        type: r.type as FactorRow['type'],
        gas: (r.gas as FactorRow['gas']) ?? undefined,
        scope: r.scope != null ? Number(r.scope) : undefined,
        value: String(r.value),
        unit: r.unit as string,
      }),
    ),
  };
}

function mapGwpSet(g: Record<string, unknown>, values: Record<string, unknown>[]): GwpSet {
  return {
    id: g.id as string,
    label: g.label as string,
    publishedAt: (g.published_at as Date).toISOString(),
    values: values.map(
      (v): GwpValue => ({ gas: v.gas as GwpValue['gas'], value: String(v.value) }),
    ),
  };
}

function mapClosure(r: Record<string, unknown>): ClosureSnapshot {
  return {
    id: r.id as string,
    plantId: (r.plant_id as string | null) ?? null,
    month: r.month as string,
    activitySeq: Number(r.activity_seq),
    factorVersionId: r.factor_version_id as string,
    gwpSetId: r.gwp_set_id as string,
    resultHash: r.result_hash as string,
    result: r.result,
    closedAt: (r.closed_at as Date).toISOString(),
  };
}

function mapBaseYearFlag(r: Record<string, unknown>): BaseYearFlag {
  return {
    id: r.id as string,
    baseYear: r.base_year as string,
    triggeredAt: (r.triggered_at as Date).toISOString(),
    factorVersionId: r.factor_version_id as string,
    gwpSetId: r.gwp_set_id as string,
    activitySeq: Number(r.activity_seq),
    referenceClosureId: (r.reference_closure_id as string | null) ?? null,
    baselineTotalTonnesCo2e: String(r.baseline_total),
    restatedTotalTonnesCo2e: String(r.restated_total),
    changeRatio: String(r.change_ratio),
    threshold: String(r.threshold),
    note: r.note as string,
  };
}
