import { FactorRow, FactorVersion, GwpSet } from './entities';

export interface FactorVersionDraft {
  id: string;
  label: string;
  effectiveStart: string;
  effectiveEnd: string | null;
  rows: Array<Omit<FactorRow, 'id' | 'factorVersionId'>>;
}

export interface GwpSetDraft {
  id: string;
  label: string;
  values: Array<{ gas: GwpSet['values'][number]['gas']; value: string }>;
}

/**
 * 因子库仓储端口。内存实现与 PostgreSQL 实现各一份；
 * 核算引擎只依赖该接口，因此核算逻辑与存储无关、可离线测试。
 */
export interface FactorStore {
  insertFactorVersion(v: FactorVersion): Promise<void>;
  getFactorVersion(id: string): Promise<FactorVersion | null>;
  listFactorVersions(): Promise<FactorVersion[]>
  insertGwpSet(g: GwpSet): Promise<void>;
  getGwpSet(id: string): Promise<GwpSet | null>;
  listGwpSets(): Promise<GwpSet[]>;
}
