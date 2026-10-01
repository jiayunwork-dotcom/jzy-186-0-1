import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from '../common/decimal';
import { ValidationError, ConflictError, NotFoundError } from '../common/errors';
import { rangesOverlap, validateMonth } from '../common/month';
import { parseUnit } from '../units/registry';
import {
  FactorRow,
  FactorRowType,
  FactorVersion,
  GASES,
  Gas,
  GwpSet,
  GwpValue,
  Scope,
} from './entities';
import { FactorStore, FactorVersionDraft, GwpSetDraft } from './store.interface';
import { FACTOR_STORE } from '../persistence/tokens';

@Injectable()
export class FactorService {
  constructor(@Inject(FACTOR_STORE) private readonly store: FactorStore) {}

  /**
   * 发布因子库版本。
   * 校验：期间合法、与既有版本适用期间不重叠、行内单位可解析、
   * 同一 (活动, 类型, 气体) 不重复、数值为正有限数。
   */
  async publishFactorVersion(draft: FactorVersionDraft): Promise<FactorVersion> {
    validateMonth(draft.effectiveStart, 'effectiveStart');
    if (draft.effectiveEnd !== null && draft.effectiveEnd !== undefined) {
      validateMonth(draft.effectiveEnd, 'effectiveEnd');
      if (draft.effectiveEnd <= draft.effectiveStart) {
        throw new ValidationError('effectiveEnd', '适用期结束月必须晚于开始月');
      }
    }
    if (!draft.id || typeof draft.id !== 'string') {
      throw new ValidationError('id', '因子版本 id 不能为空');
    }

    const existing = await this.store.listFactorVersions();
    if (existing.some((v) => v.id === draft.id)) {
      throw new ConflictError(`因子版本 ${draft.id} 已存在（版本不可变）`);
    }
    for (const v of existing) {
      if (
        rangesOverlap(
          draft.effectiveStart,
          draft.effectiveEnd ?? null,
          v.effectiveStart,
          v.effectiveEnd,
        )
      ) {
        throw new ValidationError(
          'effectiveStart',
          `适用期间与已发布版本 ${v.id}（${v.effectiveStart} ~ ${v.effectiveEnd ?? '开放'}）重叠`,
          { conflictingVersionId: v.id },
        );
      }
    }

    const seen = new Set<string>();
    const rows: FactorRow[] = draft.rows.map((r, idx) => {
      const fieldPrefix = `rows[${idx}]`;
      if (!r.fuelOrActivity) {
        throw new ValidationError(`${fieldPrefix}.fuelOrActivity`, '燃料/活动标识不能为空');
      }
      if (r.type === FactorRowType.EMISSION) {
        if (!r.gas || !GASES.includes(r.gas)) {
          throw new ValidationError(`${fieldPrefix}.gas`, '排放因子必须指定 CO2/CH4/N2O');
        }
        if (r.scope !== Scope.SCOPE_1 && r.scope !== Scope.SCOPE_2) {
          throw new ValidationError(`${fieldPrefix}.scope`, '排放因子必须指定范围 1 或 2');
        }
      } else if (r.gas || r.scope) {
        throw new ValidationError(`${fieldPrefix}.type`, '密度/热值行不允许携带 gas 或 scope');
      }

      // 数值与单位成对校验
      let value: Decimal;
      try {
        value = new Decimal(r.value);
      } catch {
        throw new ValidationError(`${fieldPrefix}.value`, '不是合法十进制数');
      }
      if (!value.isFinite() || value.isNegative()) {
        throw new ValidationError(`${fieldPrefix}.value`, '因子必须是非负的有限数');
      }
      try {
        parseUnit(r.unit);
      } catch (e) {
        throw new ValidationError(`${fieldPrefix}.unit`, (e as Error).message);
      }

      const key = `${r.fuelOrActivity}|${r.type}|${r.gas ?? ''}|${r.scope ?? ''}`;
      if (seen.has(key)) {
        throw new ValidationError(
          `${fieldPrefix}.fuelOrActivity`,
          `同一版本内因子行重复：${key}`,
        );
      }
      seen.add(key);

      return {
        id: `${draft.id}:row:${idx}`,
        factorVersionId: draft.id,
        fuelOrActivity: r.fuelOrActivity,
        type: r.type,
        gas: r.gas,
        scope: r.scope,
        value: value.toString(),
        unit: r.unit,
      };
    });

    const version: FactorVersion = {
      id: draft.id,
      label: draft.label || draft.id,
      effectiveStart: draft.effectiveStart,
      effectiveEnd: draft.effectiveEnd ?? null,
      publishedAt: new Date().toISOString(),
      rows,
    };
    await this.store.insertFactorVersion(version);
    return version;
  }

  async getFactorVersion(id: string): Promise<FactorVersion> {
    const v = await this.store.getFactorVersion(id);
    if (!v) throw new NotFoundError(`因子版本 ${id} 不存在`);
    return v;
  }

  async listFactorVersions(): Promise<FactorVersion[]> {
    return this.store.listFactorVersions();
  }

  /** 发布 GWP 集合。CO2 必须且只能为 1；三种气体齐全。 */
  async publishGwpSet(draft: GwpSetDraft): Promise<GwpSet> {
    if (!draft.id) throw new ValidationError('id', 'GWP 集合 id 不能为空');
    if (await this.store.getGwpSet(draft.id)) {
      throw new ConflictError(`GWP 集合 ${draft.id} 已存在`);
    }
    const byGas = new Map<Gas, string>();
    for (const v of draft.values ?? []) {
      if (!GASES.includes(v.gas)) {
        throw new ValidationError('values', `未知气体 ${String(v.gas)}`);
      }
      let d: Decimal;
      try {
        d = new Decimal(v.value);
      } catch {
        throw new ValidationError('values', `${v.gas} 的 GWP 不是合法十进制数`);
      }
      if (!d.isFinite() || d.lessThanOrEqualTo(0)) {
        throw new ValidationError('values', `${v.gas} 的 GWP 必须是正有限数`);
      }
      if (byGas.has(v.gas)) {
        throw new ValidationError('values', `${v.gas} 的 GWP 重复`);
      }
      byGas.set(v.gas, d.toString());
    }
    for (const gas of GASES) {
      if (!byGas.has(gas)) {
        throw new ValidationError('values', `缺少 ${gas} 的 GWP 值`);
      }
    }
    if (byGas.get('CO2') !== '1') {
      throw new ValidationError('values', 'CO2 的 GWP 必须恒为 1');
    }
    const values: GwpValue[] = GASES.map((gas) => ({ gas, value: byGas.get(gas)! }));
    const set: GwpSet = {
      id: draft.id,
      label: draft.label || draft.id,
      publishedAt: new Date().toISOString(),
      values,
    };
    await this.store.insertGwpSet(set);
    return set;
  }

  async getGwpSet(id: string): Promise<GwpSet> {
    const g = await this.store.getGwpSet(id);
    if (!g) throw new NotFoundError(`GWP 集合 ${id} 不存在`);
    return g;
  }

  async listGwpSets(): Promise<GwpSet[]> {
    return this.store.listGwpSets();
  }
}
