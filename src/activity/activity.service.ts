import { Inject, Injectable } from '@nestjs/common';
import {
  ActivityRecord,
  CorrectionRequest,
  ImportFailure,
  ImportItem,
  ImportItemResult,
} from './entities';
import { DATA_STORE } from '../persistence/tokens';
import { Store } from '../persistence/store.interface';
import { ConflictError, ValidationError } from '../common/errors';
import { validateMonth } from '../common/month';
import { parseFiniteDecimal, requireNonNegative } from '../common/decimal';
import { getSimpleUnit } from '../units/registry';

export interface ImportReport {
  results: ImportItemResult[];
  failures: ImportFailure[];
}

@Injectable()
export class ActivityService {
  constructor(@Inject(DATA_STORE) private readonly store: Store) {}

  /**
   * 批量导入。逐条校验、逐条回报；任何一条非法都不影响其余记录。
   * 整批在写临界区内执行，序号连续分配；同编号重复提交幂等（不重复计数）。
   */
  async importBatch(items: ImportItem[]): Promise<ImportReport> {
    if (!Array.isArray(items)) {
      throw new ValidationError('items', '必须是记录数组');
    }
    const results: ImportItemResult[] = [];
    const failures: ImportFailure[] = [];

    await this.store.withWriteLock(async () => {
      let seq = await this.store.getMaxSeq();
      for (const item of items) {
        try {
          const base = this.validateItem(item);
          // 只有通过校验、即将落库的记录才分配序号
          const rec: ActivityRecord = { ...base, seq: ++seq };
          const ins = await this.store.insertActivity(rec);
          if (!ins.inserted) {
            // 同编号重复提交：内容一致视为幂等重放；内容冲突则拒绝，绝不覆盖
            if (!sameBusinessContent(ins.existing, rec)) {
              failures.push({
                id: item?.id ?? null,
                status: 'rejected',
                field: 'id',
                message: `编号 ${item.id} 已被内容不同的记录占用，记录不可变；如需修改请发起更正`,
              });
              continue;
            }
            results.push({ id: item.id, status: 'duplicate', seq: ins.existing.seq });
          } else {
            results.push({ id: item.id, status: 'created', seq: rec.seq });
          }
        } catch (e) {
          if (e instanceof ValidationError) {
            failures.push({
              id: typeof item?.id === 'string' ? item.id : null,
              status: 'rejected',
              field: e.field ?? 'record',
              message: e.message,
            });
          } else {
            throw e;
          }
        }
      }
    });

    return { results, failures };
  }

  /** 单条校验，返回除 seq 外的完整记录字段 */
  private buildRecord(item: ImportItem): Omit<ActivityRecord, 'seq'> {
    const qty = requireNonNegative(parseFiniteDecimal(item.quantity, 'quantity'), 'quantity');
    getSimpleUnit(item.unit); // 简单单位（复合单位不允许出现在活动数据里）
    return {
      id: item.id,
      supersedesId: null,
      rootId: item.id,
      plantId: item.plantId,
      sourceId: item.sourceId,
      fuelOrActivity: item.fuelOrActivity,
      month: item.month,
      quantity: qty.toString(),
      unit: item.unit,
      acceptedAt: new Date().toISOString(),
    };
  }

  private validateItem(item: ImportItem): Omit<ActivityRecord, 'seq'> {
    if (!item || typeof item !== 'object') {
      throw new ValidationError('record', '记录必须是对象');
    }
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      throw new ValidationError('id', '记录编号不能为空');
    }
    for (const f of ['plantId', 'sourceId', 'fuelOrActivity', 'unit'] as const) {
      if (typeof item[f] !== 'string' || (item[f] as string).trim() === '') {
        throw new ValidationError(f, `${f} 不能为空`);
      }
    }
    const month = validateMonth(item.month, 'month');
    return this.buildRecord({ ...item, id: item.id.trim(), month });
  }

  /**
   * 更正记录。原记录保留；插入一条指向目标的新记录。
   * - 目标不存在：字段级校验错误；
   * - 目标已被更正：409 冲突（两个并发更正只接受第一个）；
   * - correctionId 重复提交：幂等返回既有更正。
   * 整段在写临界区（内存互斥 / PG SERIALIZABLE + 咨询锁）内，
   * 因此两个并发更正不可能同时观察到同一链头。
   */
  async correct(req: CorrectionRequest): Promise<{ status: 'created' | 'duplicate'; record: ActivityRecord }> {
    if (!req || typeof req !== 'object') {
      throw new ValidationError('correction', '更正请求必须是对象');
    }
    if (typeof req.correctionId !== 'string' || req.correctionId.trim() === '') {
      throw new ValidationError('correctionId', '更正记录编号不能为空');
    }
    if (typeof req.targetId !== 'string' || req.targetId.trim() === '') {
      throw new ValidationError('targetId', '被更正记录编号不能为空');
    }

    return this.store.withWriteLock(async () => {
      // 幂等：同一更正编号重复提交，原样返回
      const prior = await this.store.getById(req.correctionId);
      if (prior) {
        return { status: 'duplicate', record: prior };
      }

      const target = await this.store.getById(req.targetId);
      if (!target) {
        throw new ValidationError('targetId', `更正指向的记录 ${req.targetId} 不存在`);
      }
      const chain = await this.store.getChainByRoot(target.rootId);
      const head = chain.reduce((a, b) => (b.seq > a.seq ? b : a));
      if (target.id !== head.id) {
        const child = chain.find((r) => r.supersedesId === target.id);
        throw new ConflictError(
          `记录 ${target.id} 已被更正记录 ${child?.id ?? head.id} 取代，不能对其再次更正；请更正当前生效记录 ${head.id}`,
          { targetId: target.id, supersededBy: child?.id ?? head.id, headId: head.id },
        );
      }

      const qty = requireNonNegative(parseFiniteDecimal(req.quantity, 'quantity'), 'quantity');
      getSimpleUnit(req.unit);

      const seq = (await this.store.getMaxSeq()) + 1;
      const rec: ActivityRecord = {
        id: req.correctionId,
        supersedesId: target.id,
        rootId: target.rootId,
        plantId: target.plantId,
        sourceId: target.sourceId,
        fuelOrActivity: target.fuelOrActivity,
        month: target.month,
        quantity: qty.toString(),
        unit: req.unit,
        seq,
        acceptedAt: new Date().toISOString(),
      };
      const ins = await this.store.insertActivity(rec);
      if (!ins.inserted) {
        // 临界区内理论上不会发生（上面已查），作为兜底幂等返回
        return { status: 'duplicate', record: ins.existing };
      }
      return { status: 'created', record: rec };
    });
  }

  async getRecord(id: string): Promise<ActivityRecord> {
    const r = await this.store.getById(id);
    if (!r) throw new ValidationError('id', `记录 ${id} 不存在`);
    return r;
  }

  /** 截止点 'latest' 解析为当前最大序号 */
  async resolveSeq(seq: number | 'latest'): Promise<number> {
    return seq === 'latest' ? this.store.getMaxSeq() : seq;
  }

  /**
   * 取某截止点下全部“生效”记录：按 rootId 归并更正链，
   * 选 seq 最大的一条。原始与被更正记录均保留，只是不生效。
   */
  async getActiveRecords(seq: number): Promise<ActivityRecord[]> {
    const all = await this.store.listRecordsUpTo(seq);
    const byRoot = new Map<string, ActivityRecord>();
    for (const r of all) {
      const cur = byRoot.get(r.rootId);
      if (!cur || r.seq > cur.seq) byRoot.set(r.rootId, r);
    }
    return [...byRoot.values()];
  }

  async getChain(rootId: string): Promise<ActivityRecord[]> {
    return this.store.getChainByRoot(rootId);
  }
}

function sameBusinessContent(a: ActivityRecord, b: ActivityRecord): boolean {
  return (
    a.plantId === b.plantId &&
    a.sourceId === b.sourceId &&
    a.fuelOrActivity === b.fuelOrActivity &&
    a.month === b.month &&
    a.quantity === b.quantity &&
    a.unit === b.unit &&
    a.supersedesId === b.supersedesId &&
    a.rootId === b.rootId
  );
}
