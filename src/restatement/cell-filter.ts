import { Scope } from '../factors/entities';
import { AggCell } from '../accounting/aggregation';

/**
 * 汇总层级过滤器。叶子格子上做谓词筛选后再求和，
 * 即可在任意层级（公司/厂区/排放源、年/月、范围一/二）上做分解。
 */
export interface CellFilterSpec {
  plantId?: string | null; // null 表示公司层（所有厂区）；省略同 null
  sourceId?: string; // 指定排放源；省略表示跨排放源
  year?: string | number;
  month?: string;
  scope?: Scope;
}

export class CellFilter {
  private constructor(private readonly spec: CellFilterSpec) {}

  static of(spec: CellFilterSpec = {}): CellFilter {
    return new CellFilter(spec);
  }

  static describe(spec: CellFilterSpec = {}): string {
    const parts = [
      spec.plantId === undefined || spec.plantId === null ? 'company' : `plant=${spec.plantId}`,
      spec.sourceId ? `source=${spec.sourceId}` : 'all-sources',
      spec.month ? `month=${spec.month}` : spec.year ? `year=${spec.year}` : 'all-months',
      `scope=${spec.scope ?? '1+2'}`,
    ];
    return parts.join('/');
  }

  matches(c: AggCell): boolean {
    const s = this.spec;
    if (s.plantId !== undefined && s.plantId !== null && c.plantId !== s.plantId) return false;
    if (s.sourceId !== undefined && c.sourceId !== s.sourceId) return false;
    if (s.month !== undefined && c.month !== s.month) return false;
    if (s.year !== undefined && c.month?.slice(0, 4) !== String(s.year)) return false;
    if (s.scope !== undefined && c.scope !== s.scope) return false;
    return true;
  }
}
