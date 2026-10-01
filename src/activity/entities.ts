/**
 * 活动数据记录。
 *
 * 更正链设计：
 * - 每条记录（原始记录或更正记录）都有全局唯一 id；
 * - 更正“不修改旧记录”，而是插入一条 supersedesId 指向被更正记录的新记录；
 * - rootId 指向链条最顶端的原始记录，便于快速归集同一业务事实的所有版本；
 * - 某截止点 effectiveAtSeq 下，链条中“seq <= cutoffSeq 的最后一条”生效，
 *   被后续记录更正的旧记录不再参与核算，但永远保留可追溯。
 */
export interface ActivityRecord {
  id: string;
  supersedesId: string | null;
  rootId: string;
  plantId: string;
  sourceId: string;
  fuelOrActivity: string;
  month: string; // YYYY-MM
  quantity: string; // 高精度十进制字符串
  unit: string;
  /** 单调递增的接受序号（导入/更正成功时分配），即活动数据时间轴 */
  seq: number;
  acceptedAt: string; // ISO 时间戳
}

export interface ImportItem {
  id: string;
  plantId: string;
  sourceId: string;
  fuelOrActivity: string;
  month: string;
  quantity: string | number;
  unit: string;
}

export interface ImportItemResult {
  id: string;
  status: 'created' | 'duplicate';
  seq?: number;
}

export interface ImportFailure {
  id: string | null;
  status: 'rejected';
  field: string;
  message: string;
}

export interface CorrectionRequest {
  /** 新更正记录的唯一编号（重复提交幂等） */
  correctionId: string;
  targetId: string;
  quantity: string | number;
  unit: string;
}

export interface ActivityCutoff {
  /** 活动数据截止点：'latest' 或具体接受序号 */
  seq: number | 'latest';
}
