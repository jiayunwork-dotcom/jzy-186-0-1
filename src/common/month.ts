import { ValidationError } from './errors';

/** 月份统一用 YYYY-MM 表示与存储（ISO 字符串，字典序即时间序） */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function validateMonth(raw: unknown, field = 'month'): string {
  if (typeof raw !== 'string' || !MONTH_RE.test(raw)) {
    throw new ValidationError(field, '月份必须是 YYYY-MM 格式');
  }
  return raw;
}

/** 半开区间月份比较：[startMonth, endMonthExclusive) */
export function monthInRange(
  month: string,
  startMonth: string,
  endMonthExclusive: string | null,
): boolean {
  return month >= startMonth && (endMonthExclusive === null || month < endMonthExclusive);
}

/** 判断两个半开适用期间是否重叠 */
export function rangesOverlap(
  aStart: string,
  aEnd: string | null,
  bStart: string,
  bEnd: string | null,
): boolean {
  return aStart < (bEnd ?? '9999-13') && bStart < (aEnd ?? '9999-13');
}

/** 年份的全部月份，按时间顺序 */
export function monthsOfYear(year: number | string): string[] {
  const y = String(year);
  return Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
}
