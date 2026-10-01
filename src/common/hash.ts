import { createHash } from 'crypto';

/**
 * 规范化 JSON：对象键排序后序列化。用于：
 * 1. 快照/汇总结果的内容指纹（hash），证明同一口径任何时候算出的结果一致；
 * 2. 幂等键（记录编号）之外的内容比对。
 * 哈希内容只包含数据本身，不含时间戳、序列号等环境变量。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
