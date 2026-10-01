import { ActivityRecord } from './entities';

/**
 * 活动数据仓储端口。
 * 实现必须保证：
 * - insertActivity 对 id 做唯一约束（重复提交同一编号不重复计数）；
 * - 两个并发更正指向同一生效记录时，只允许一个成功（唯一约束冲突）；
 * - seq 单调分配、无空洞竞争问题（内存用互斥队列，PG 用 bigserial + 约束）。
 */
export interface ActivityStore {
  getById(id: string): Promise<ActivityRecord | null>;
  /** 按 rootId 取整条更正链，按 seq 升序 */
  getChainByRoot(rootId: string): Promise<ActivityRecord[]>;
  /** 批量取链条（追溯时避免 N+1） */
  getChainsByRoots(rootIds: string[]): Promise<ActivityRecord[]>;
  /** 插入；若 id 已存在返回 existing（幂等），不做更新 */
  insertActivity(rec: ActivityRecord): Promise<{ inserted: true } | { inserted: false; existing: ActivityRecord }>;
  /** 当前最大接受序号，空库为 0 */
  getMaxSeq(): Promise<number>;
  /** 列出截止点之前的全部记录（引擎按 rootId 自行归并生效版本） */
  listRecordsUpTo(seq: number): Promise<ActivityRecord[]>;
  /** 条件列出（管理/追溯用），按 seq 升序 */
  listAll(filter?: { plantId?: string; month?: string }): Promise<ActivityRecord[]>;
}
