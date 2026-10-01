import { Decimal } from '../common/decimal';
import { monthInRange } from '../common/month';
import { FactorRow, FactorVersion, FactorRowType, Gas, Scope } from '../factors/entities';
import { convertCompoundToBases } from '../units/converter';
import { ValidationError } from '../common/errors';

/**
 * 某燃料/活动在一个因子版本内的解析结果。
 * 排放因子按 (gas, scope) 索引；换算参数已折算为基础单位比值
 * （density kg/m³、ncvMass GJ/kg、ncvVolume GJ/m³）。
 */
export interface ResolvedFuelFactors {
  fuelOrActivity: string;
  emissions: Array<{
    row: FactorRow;
    gas: Gas;
    scope: Scope;
    /** kg 每基础活动单位（kg/GJ、kg/m³、kg/kg） */
  factorKgPerBase: Decimal;
  }>;
  density?: { row: FactorRow; kgPerM3: Decimal };
  ncvMass?: { row: FactorRow; gjPerKg: Decimal };
  ncvVolume?: { row: FactorRow; gjPerM3: Decimal };
}

export class FactorIndex {
  private byFuel = new Map<string, ResolvedFuelFactors>();

  constructor(public readonly version: FactorVersion) {
    for (const row of version.rows) {
      let entry = this.byFuel.get(row.fuelOrActivity);
      if (!entry) {
        entry = { fuelOrActivity: row.fuelOrActivity, emissions: [] };
        this.byFuel.set(row.fuelOrActivity, entry);
      }
      if (row.type === FactorRowType.EMISSION) {
        entry.emissions.push({
          row,
          gas: row.gas!,
          scope: row.scope!,
          factorKgPerBase: convertCompoundToBases(new Decimal(row.value), row.unit),
        });
      } else if (row.type === FactorRowType.DENSITY) {
        entry.density = { row, kgPerM3: convertCompoundToBases(new Decimal(row.value), row.unit) };
      } else if (row.type === FactorRowType.NCV_MASS) {
        entry.ncvMass = { row, gjPerKg: convertCompoundToBases(new Decimal(row.value), row.unit) };
      } else if (row.type === FactorRowType.NCV_VOLUME) {
        entry.ncvVolume = { row, gjPerM3: convertCompoundToBases(new Decimal(row.value), row.unit) };
      }
    }
  }

  /** 月份适用性校验（半开区间） */
  coversMonth(month: string): boolean {
    return monthInRange(month, this.version.effectiveStart, this.version.effectiveEnd);
  }

  get(fuelOrActivity: string): ResolvedFuelFactors | null {
    return this.byFuel.get(fuelOrActivity) ?? null;
  }

  require(
    month: string,
    fuelOrActivity: string,
    opts: { strictPeriod?: boolean } = {},
  ): ResolvedFuelFactors {
    if (opts.strictPeriod !== false && !this.coversMonth(month)) {
      throw new ValidationError(
        'month',
        `月份 ${month} 不在因子版本 ${this.version.id} 适用期间 ` +
          `${this.version.effectiveStart} ~ ${this.version.effectiveEnd ?? '开放'} 内`,
        { month, factorVersionId: this.version.id },
      );
    }
    const f = this.byFuel.get(fuelOrActivity);
    if (!f || f.emissions.length === 0) {
      throw new ValidationError(
        'fuelOrActivity',
        `因子版本 ${this.version.id} 中没有活动 ${fuelOrActivity} 的排放因子`,
        { fuelOrActivity, factorVersionId: this.version.id, month },
      );
    }
    return f;
  }
}
