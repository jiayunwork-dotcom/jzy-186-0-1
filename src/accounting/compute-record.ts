import { Decimal } from '../common/decimal';
import { ActivityRecord } from '../activity/entities';
import { Gas, GASES, Scope } from '../factors/entities';
import { ConversionParams } from '../units/model';
import { getSimpleUnit } from '../units/registry';
import { convertActivity } from '../units/converter';
import { ValidationError } from '../common/errors';
import { FactorIndex, ResolvedFuelFactors } from './factor-index';
import { FactorRow } from '../factors/entities';

/** 单条生效活动记录的三气体原始质量（kg）与折算参数追溯 */
export interface RecordEmission {
  recordId: string;
  rootId: string;
  plantId: string;
  sourceId: string;
  fuelOrActivity: string;
  month: string;
  scope: Scope;
  /** 产生该结果的那条生效活动记录（完整、不可变），供追溯直接引用 */
  sourceRecord: ActivityRecord;
  /** 折算到因子量纲后的活动量（展示/追溯用） */
  baseActivityAmount: string;
  baseActivityUnit: string;
  /** 每种气体的排放质量 kg（全精度 Decimal） */
  kgByGas: Record<Gas, Decimal>;
  /** 追溯：本记录实际使用的因子行 */
  factorRowsUsed: Array<{ factorRowId: string; value: string; unit: string; gas?: Gas }>;
  /** 追溯：单位换算实际使用的密度/热值行 */
  conversionRowsUsed: Array<{ factorRowId: string; kind: 'density' | 'ncvMass' | 'ncvVolume'; value: string; unit: string }>;
  /** 追溯：从记录单位到因子单位的换算说明 */
  conversionPath: string;
}

/**
 * 计算单条记录。
 *
 * 因子单位（分母）决定目标量纲：
 *   - CO₂/CH₄/N₂O 三种气体的因子必须同量纲（同一燃料的标准做法）；
 *   - 记录单位经密度/热值换算到该量纲，再乘因子得 kg 气体质量。
 * 换算参数缺失或单位不认识时抛出字段级 ValidationError。
 */
export function computeRecord(
  record: ActivityRecord,
  index: FactorIndex,
  opts: { strictPeriod?: boolean } = {},
): RecordEmission {
  const fuel = index.require(record.month, record.fuelOrActivity, opts);

  // 由因子行复合单位推导目标量纲
  const denomDimensions = new Set(fuel.emissions.map((e) => getSimpleUnit(e.row.unit.split('/')[1].trim()).dimension));
  if (denomDimensions.size !== 1) {
    throw new ValidationError(
      'factorUnit',
      `活动 ${record.fuelOrActivity} 的三种气体因子分母量纲不一致`,
      { recordId: record.id, fuelOrActivity: record.fuelOrActivity },
    );
  }
  const targetDimension = [...denomDimensions][0];
  const targetBaseUnit = targetDimension === 'mass' ? 'kg' : targetDimension === 'volume' ? 'm3' : 'GJ';

  const params: ConversionParams = {};
  const conversionRowsUsed: RecordEmission['conversionRowsUsed'] = [];
  if (fuel.density) {
    params.density = fuel.density.kgPerM3.toString();
    conversionRowsUsed.push({
      factorRowId: fuel.density.row.id,
      kind: 'density',
      value: fuel.density.row.value,
      unit: fuel.density.row.unit,
    });
  }
  if (fuel.ncvMass) {
    params.ncvMass = fuel.ncvMass.gjPerKg.toString();
    conversionRowsUsed.push({
      factorRowId: fuel.ncvMass.row.id,
      kind: 'ncvMass',
      value: fuel.ncvMass.row.value,
      unit: fuel.ncvMass.row.unit,
    });
  }
  if (fuel.ncvVolume) {
    params.ncvVolume = fuel.ncvVolume.gjPerM3.toString();
    conversionRowsUsed.push({
      factorRowId: fuel.ncvVolume.row.id,
      kind: 'ncvVolume',
      value: fuel.ncvVolume.row.value,
      unit: fuel.ncvVolume.row.unit,
    });
  }

  const amount = new Decimal(record.quantity);
  let baseAmount: Decimal;
  try {
    baseAmount = convertActivity(amount, record.unit, targetBaseUnit, params);
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new ValidationError(
        'unit',
        `记录 ${record.id}（${record.fuelOrActivity}）：${e.message}`,
        { recordId: record.id, ...(e.details ?? {}) },
      );
    }
    throw e;
  }

  const scopes = new Set(fuel.emissions.map((e) => e.scope));
  if (scopes.size !== 1) {
    throw new ValidationError(
      'scope',
      `活动 ${record.fuelOrActivity} 的因子范围不一致（必须全部范围一或全部范围二）`,
      { recordId: record.id },
    );
  }
  const scope = [...scopes][0];

  const kgByGas = { CO2: new Decimal(0), CH4: new Decimal(0), N2O: new Decimal(0) } as Record<Gas, Decimal>;
  const factorRowsUsed: RecordEmission['factorRowsUsed'] = [];
  for (const e of fuel.emissions) {
    kgByGas[e.gas] = baseAmount.mul(e.factorKgPerBase);
    factorRowsUsed.push({
      factorRowId: e.row.id,
      value: e.row.value,
      unit: e.row.unit,
      gas: e.gas,
    });
  }

  return {
    recordId: record.id,
    rootId: record.rootId,
    plantId: record.plantId,
    sourceId: record.sourceId,
    fuelOrActivity: record.fuelOrActivity,
    month: record.month,
    scope,
    sourceRecord: record,
    baseActivityAmount: baseAmount.toString(),
    baseActivityUnit: targetBaseUnit === 'm3' ? 'm³' : targetBaseUnit,
    kgByGas,
    factorRowsUsed,
    conversionRowsUsed: filterConversionUsed(conversionRowsUsed, record, targetBaseUnit),
    conversionPath: `${record.quantity} ${record.unit} -> ${baseAmount.toString()} ${targetBaseUnit}`,
  };
}

/** 追溯里只保留本次换算实际经过的参数行，避免把无关因子也列入 */
function filterConversionUsed(
  rows: RecordEmission['conversionRowsUsed'],
  record: ActivityRecord,
  targetBaseUnit: string,
): RecordEmission['conversionRowsUsed'] {
  const from = getSimpleUnit(record.unit).dimension;
  const to = getSimpleUnit(targetBaseUnit).dimension;
  if (from === to) return [];
  const need = new Set<string>();
  if ((from === 'volume' && to === 'mass') || (from === 'mass' && to === 'volume')) need.add('density');
  if ((from === 'volume' && to === 'energy') || (from === 'energy' && to === 'volume')) need.add('ncvVolume');
  if ((from === 'mass' && to === 'energy') || (from === 'energy' && to === 'mass')) need.add('ncvMass');
  return rows.filter((r) => need.has(r.kind));
}

export function zeroKgByGas(): Record<Gas, Decimal> {
  return {
    CO2: new Decimal(0),
    CH4: new Decimal(0),
    N2O: new Decimal(0),
  };
}

export function addKgByGas(a: Record<Gas, Decimal>, b: Record<Gas, Decimal>): Record<Gas, Decimal> {
  const out = zeroKgByGas();
  for (const g of GASES) out[g] = a[g].plus(b[g]);
  return out;
}

export type { FactorRow, ResolvedFuelFactors };
