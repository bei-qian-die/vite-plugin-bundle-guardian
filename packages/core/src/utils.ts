/**
 * 通用工具：体积单位解析与格式化
 */

const SIZE_RE = /^\s*(-?\d+(?:\.\d+)?)\s*(b|kb|mb|kib|mib|gb)?\s*$/i;
const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 * 1000,
  mib: 1024 * 1024,
  gb: 1000 * 1000 * 1000,
};

/**
 * 解析体积字符串：'300 KB' | '1.5MB' | '2 MiB' | 1024（裸数字按字节）
 * KB 采用 SI 十进制，与 size-limit / bundlesize 生态保持一致。
 */
export function parseSize(input: string | number): number {
  if (typeof input === 'number') return Math.max(0, Math.round(input));
  const m = SIZE_RE.exec(input);
  if (!m) throw new Error(`无法解析的体积表达式: "${input}"`);
  const value = Number(m[1]);
  const unit = (m[2] ?? 'b').toLowerCase();
  return Math.max(0, Math.round(value * UNIT_BYTES[unit]));
}

/** 解析百分比：'5%' | 0.05 → 0.05 */
export function parseRatio(input: string | number): number {
  if (typeof input === 'number') return input;
  const trimmed = input.trim();
  if (trimmed.endsWith('%')) return Number(trimmed.slice(0, -1)) / 100;
  return Number(trimmed);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1000 * 1000) return `${(bytes / 1000 / 1000).toFixed(2)} MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatPercent(ratio: number, digits = 1): string {
  const p = ratio * 100;
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(digits)}%`;
}

export function ratio(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : Infinity;
  return (current - previous) / previous;
}

/** 取 Top N，同时把剩余项合并成 other */
export function topN<T>(list: T[], n: number, pickValue: (item: T) => number): {
  top: T[];
  restCount: number;
  restValue: number;
} {
  const top = list.slice(0, n);
  let restValue = 0;
  for (let i = n; i < list.length; i++) restValue += pickValue(list[i]);
  return { top, restCount: Math.max(0, list.length - n), restValue };
}

export function padEnd(str: string, len: number): string {
  // 中文/全角字符按 2 列宽计算，保证终端表格对齐
  let width = 0;
  for (const ch of str) width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, len - width));
}

export function padStart(str: string, len: number): string {
  let width = 0;
  for (const ch of str) width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return ' '.repeat(Math.max(0, len - width)) + str;
}
