/**
 * 月度关账快照。
 *
 * 关账是一个显式操作：开始的一瞬间把三个口径坐标钉死
 * （activitySeq / factorVersionId / gwpSetId），随后在同一事务/临界区内
 * 完成全部核算并落盘。关账进行中若有人发布因子或提交更正，结果只认
 * 开始那一刻的数据——内存实现用互斥临界区，PG 实现先在可串行化事务中
 * 捕获三个坐标再计算。
 *
 * 快照内容不可变；同一 (plantId, month) 重复关账返回 409。
 */
export interface ClosureSnapshot {
  id: string;
  plantId: string | null; // null = 公司全厂区合并关账
  month: string;
  activitySeq: number;
  factorVersionId: string;
  gwpSetId: string;
  resultHash: string;
  /** 完整汇总结果（含分气体明细），JSON 列 */
  result: unknown;
  closedAt: string;
}

/** 基准年重算标记与说明记录 */
export interface BaseYearFlag {
  id: string;
  baseYear: string;
  triggeredAt: string;
  /** 触发时采用的口径 */
  factorVersionId: string;
  gwpSetId: string;
  activitySeq: number;
  /** 对比的参照快照/口径（通常为基准年最近一次已关账快照） */
  referenceClosureId: string | null;
  baselineTotalTonnesCo2e: string;
  restatedTotalTonnesCo2e: string;
  changeRatio: string;
  threshold: string;
  note: string;
}

export interface ClosureStore {
  insertClosure(s: ClosureSnapshot): Promise<void>;
  getClosure(id: string): Promise<ClosureSnapshot | null>;
  findClosure(plantId: string | null, month: string): Promise<ClosureSnapshot | null>;
  listClosures(filter?: { plantId?: string; month?: string }): Promise<ClosureSnapshot[]>;

  upsertBaseYearFlag(flag: BaseYearFlag): Promise<void>;
  getBaseYearFlag(baseYear: string): Promise<BaseYearFlag | null>;
  listBaseYearFlags(): Promise<BaseYearFlag[]>;
}
