import { Decimal } from '../../src/common/decimal';
import { convertActivity, convertCompoundToBases } from '../../src/units/converter';
import { parseUnit } from '../../src/units/registry';
import { ValidationError } from '../../src/common/errors';

describe('单位换算', () => {
  test('同量纲十进倍率：t <-> kg，L <-> m3，kWh <-> GJ', () => {
    expect(convertActivity(new Decimal(2), 't', 'kg').toString()).toBe('2000');
    expect(convertActivity(new Decimal(5000), 'L', 'm3').toString()).toBe('5');
    expect(convertActivity(new Decimal(1000), 'kWh', 'GJ').toString()).toBe('3.6');
    expect(convertActivity(new Decimal(3.6), 'GJ', 'kWh').toString()).toBe('1000');
  });

  test('跨量纲：体积 × 密度 = 质量', () => {
    const params = { density: '800' /* kg/m3 */ };
    expect(convertActivity(new Decimal(10), 'm3', 'kg', params).toString()).toBe('8000');
    expect(convertActivity(new Decimal(1000), 'L', 'kg', params).toString()).toBe('800');
  });

  test('跨量纲：质量 × 热值 = 能量', () => {
    // 50 GJ/t 折算为 0.05 GJ/kg
    const nc = convertCompoundToBases(new Decimal(50), 'GJ/t');
    expect(nc.toString()).toBe('0.05');
    const v = convertActivity(new Decimal(2000), 'kg', 'GJ', { ncvMass: nc.toString() });
    expect(v.toString()).toBe('100');
  });

  test('体积 -> 能量（体积热值 GJ/m3）', () => {
    const v = convertActivity(new Decimal(100), 'm3', 'GJ', { ncvVolume: '0.04' });
    expect(v.toString()).toBe('4');
  });

  test('换算往返不变（volume -> mass -> energy -> mass -> volume）', () => {
    const params = { density: '0.8', ncvMass: '0.05' }; // kg/L? 这里 density 基础单位 kg/m3
    // 用统一基础单位参数：1 m3 = 800 kg；1 kg = 0.05 GJ
    const p2 = { density: '800', ncvMass: '0.05' };
    const v0 = new Decimal('123.456');
    const energy = convertActivity(v0, 'm3', 'GJ', { ncvVolume: '40' }); // m3 -> GJ 直接体积热值
    const back = convertActivity(energy, 'GJ', 'm3', { ncvVolume: '40' });
    expect(back.equals(v0)).toBe(true);

    // m3 -> kg -> GJ 与直接 m3 -> GJ（体积热值自洽）一致
    const viaMass = convertActivity(convertActivity(v0, 'm3', 'kg', p2), 'kg', 'GJ', p2);
    expect(viaMass.equals(energy)).toBe(true);

    // 任意十进制往返逐位相等
    const r1 = convertActivity(v0, 'm3', 'kg', p2);
    const r0 = convertActivity(r1, 'kg', 'm3', p2);
    expect(r0.equals(v0)).toBe(true);
  });

  test('缺少换算参数时报字段级错误', () => {
    expect(() => convertActivity(new Decimal(1), 'm3', 'GJ', {})).toThrow(ValidationError);
    try {
      convertActivity(new Decimal(1), 'm3', 'GJ', {});
    } catch (e) {
      expect((e as ValidationError).field).toBe('unit');
      expect((e as ValidationError).details).toMatchObject({ missingParam: 'ncvVolume' });
    }
  });

  test('未知单位报错', () => {
    expect(() => parseUnit('frobnicate')).toThrow(ValidationError);
  });

  test('复合单位折算：0.8 kg/L -> 800 kg/m3；56.1 kg/GJ 恒等', () => {
    expect(convertCompoundToBases(new Decimal('0.8'), 'kg/L').toString()).toBe('800');
    expect(convertCompoundToBases(new Decimal('56.1'), 'kg/GJ').toString()).toBe('56.1');
  });
});
