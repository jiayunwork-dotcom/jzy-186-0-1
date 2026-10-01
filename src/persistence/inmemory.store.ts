import { ActivityRecord } from '../activity/entities';
import { FactorVersion, GwpSet } from '../factors/entities';
import { BaseYearFlag, ClosureSnapshot } from '../closure/entities';
import { Store } from './store.interface';
import { Mutex } from '../common/mutex';
import { ConflictError } from '../common/errors';

/**
 * 内存存储实现。
 *
 * 用单一写互斥队列串行化所有写操作以及关账临界区，因此：
 * - seq 分配与去重天然原子；
 * - “同一生效记录的两个并发更正只接受一个”由调用方的先查后插
 *   在 withWriteLock 内原子完成；
 * - 关账捕获的活动截止点与核算过程之间不可能插入新写入。
 *
 * 数据按插入顺序保存；读操作返回拷贝，避免调用方意外篡改。
 */
export class InMemoryStore implements Store {
  private activities = new Map<string, ActivityRecord>();
  private insertionOrder: string[] = [];
  private factorVersions = new Map<string, FactorVersion>();
  private gwpSets = new Map<string, GwpSet>();
  private closures = new Map<string, ClosureSnapshot>();
  private baseYearFlags = new Map<string, BaseYearFlag>();
  private writeMutex = new Mutex();

  async init(): Promise<void> {
    /* 无外部资源需要初始化 */
  }

  withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.writeMutex.run(fn);
  }

  // ---- 活动数据 ----

  async getById(id: string): Promise<ActivityRecord | null> {
    const r = this.activities.get(id);
    return r ? { ...r } : null;
  }

  async getChainByRoot(rootId: string): Promise<ActivityRecord[]> {
    return this.insertionOrder
      .map((id) => this.activities.get(id)!)
      .filter((r) => r.rootId === rootId)
      .map((r) => ({ ...r }));
  }

  async getChainsByRoots(rootIds: string[]): Promise<ActivityRecord[]> {
    const set = new Set(rootIds);
    return this.insertionOrder
      .map((id) => this.activities.get(id)!)
      .filter((r) => set.has(r.rootId))
      .map((r) => ({ ...r }));
  }

  async insertActivity(
    rec: ActivityRecord,
  ): Promise<{ inserted: true } | { inserted: false; existing: ActivityRecord }> {
    return this.writeMutex.run(async () => {
      const existing = this.activities.get(rec.id);
      if (existing) {
        return { inserted: false, existing: { ...existing } };
      }
      const stored: ActivityRecord = { ...rec };
      this.activities.set(rec.id, stored);
      this.insertionOrder.push(rec.id);
      return { inserted: true };
    });
  }

  async getMaxSeq(): Promise<number> {
    let max = 0;
    for (const id of this.insertionOrder) {
      const s = this.activities.get(id)!.seq;
      if (s > max) max = s;
    }
    return max;
  }

  async listRecordsUpTo(seq: number): Promise<ActivityRecord[]> {
    return this.insertionOrder
      .map((id) => this.activities.get(id)!)
      .filter((r) => r.seq <= seq)
      .map((r) => ({ ...r }));
  }

  async listAll(filter?: { plantId?: string; month?: string }): Promise<ActivityRecord[]> {
    return this.insertionOrder
      .map((id) => this.activities.get(id)!)
      .filter(
        (r) =>
          (!filter?.plantId || r.plantId === filter.plantId) &&
          (!filter?.month || r.month === filter.month),
      )
      .map((r) => ({ ...r }));
  }

  // ---- 因子库 ----

  async insertFactorVersion(v: FactorVersion): Promise<void> {
    this.factorVersions.set(v.id, structuredClone(v));
  }

  async getFactorVersion(id: string): Promise<FactorVersion | null> {
    const v = this.factorVersions.get(id);
    return v ? structuredClone(v) : null;
  }

  async listFactorVersions(): Promise<FactorVersion[]> {
    return [...this.factorVersions.values()].map((v) => structuredClone(v));
  }

  async insertGwpSet(g: GwpSet): Promise<void> {
    this.gwpSets.set(g.id, structuredClone(g));
  }

  async getGwpSet(id: string): Promise<GwpSet | null> {
    const g = this.gwpSets.get(id);
    return g ? structuredClone(g) : null;
  }

  async listGwpSets(): Promise<GwpSet[]> {
    return [...this.gwpSets.values()].map((g) => structuredClone(g));
  }

  // ---- 关账与基准年 ----

  async insertClosure(s: ClosureSnapshot): Promise<void> {
    if (this.closures.has(s.id)) {
      throw new ConflictError(`关账快照 ${s.id} 已存在`);
    }
    for (const c of this.closures.values()) {
      if (c.plantId === s.plantId && c.month === s.month) {
        throw new ConflictError(`厂区 ${s.plantId ?? '(全公司)'} 的 ${s.month} 已关账，快照不可变`);
      }
    }
    this.closures.set(s.id, structuredClone(s));
  }

  async getClosure(id: string): Promise<ClosureSnapshot | null> {
    const c = this.closures.get(id);
    return c ? structuredClone(c) : null;
  }

  async findClosure(plantId: string | null, month: string): Promise<ClosureSnapshot | null> {
    for (const c of this.closures.values()) {
      if (c.plantId === plantId && c.month === month) return structuredClone(c);
    }
    return null;
  }

  async listClosures(filter?: { plantId?: string; month?: string }): Promise<ClosureSnapshot[]> {
    return [...this.closures.values()]
      .filter(
        (c) =>
          (!filter?.plantId || c.plantId === filter.plantId) &&
          (!filter?.month || c.month === filter.month),
      )
      .map((c) => structuredClone(c))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  async upsertBaseYearFlag(flag: BaseYearFlag): Promise<void> {
    this.baseYearFlags.set(flag.baseYear, structuredClone(flag));
  }

  async getBaseYearFlag(baseYear: string): Promise<BaseYearFlag | null> {
    const f = this.baseYearFlags.get(baseYear);
    return f ? structuredClone(f) : null;
  }

  async listBaseYearFlags(): Promise<BaseYearFlag[]> {
    return [...this.baseYearFlags.values()].map((f) => structuredClone(f));
  }
}
