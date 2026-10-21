/**
 * 体积预算引擎 + baseline 增量门禁
 *
 * 四类预算匹配方式：
 *   contains  —— 文件名包含（最常见，用来圈定某个入口）
 *   pkgs      —— 命中的 npm 包归因体积之和（跨 chunk 累加）
 *   ext       —— 按扩展名过滤 css / js
 *   each      —— 对每个命中产物分别套用同一限额
 */

import { parseSize, parseRatio } from './utils.js';
import type {
  AssetRecord,
  BaselineDelta,
  Budget,
  BudgetField,
  BudgetResult,
  PkgStat,
} from './types.js';

export interface CheckInput {
  assets: AssetRecord[];
  pkgs: PkgStat[];
  budgets: Budget[];
}

function pickSize(record: AssetRecord, field: BudgetField): number {
  return record.size[field];
}

function matchesBudget(record: AssetRecord, budget: Budget): boolean {
  if (budget.ext && record.ext !== budget.ext) return false;
  if (budget.contains) {
    const c = budget.contains;
    const hit = typeof c === 'string' ? record.fileName.includes(c) : c.test(record.fileName);
    if (!hit) return false;
  }
  return true;
}

/**
 * 执行所有预算检查。
 * limit 缺失或非法的预算会被静默跳过（配置错误不该让构建崩掉）。
 */
export function checkBudgets(input: CheckInput): BudgetResult[] {
  const { assets, pkgs, budgets } = input;
  const results: BudgetResult[] = [];

  for (const budget of budgets) {
    const field: BudgetField = 'gzip';

    // ── ① 包维度预算 ──
    if (budget.pkgs && budget.pkgs.length > 0) {
      const limit = toLimit(budget.maxTotal ?? budget.maxGzip);
      if (limit === null) continue;

      const hitPkgs = pkgs.filter((p) => budget.pkgs!.includes(p.pkg));
      const actual = hitPkgs.reduce((s, p) => s + p.gzipBytes, 0);
      results.push(
        makeResult(budget, field, actual, limit, hitPkgs.map((p) => p.pkg))
      );
      continue;
    }

    const matched = assets.filter((a) => matchesBudget(a, budget));

    // ── ② each 模式：逐产物校验 ──
    if (budget.each) {
      const limit = toLimit(budget.maxGzip ?? budget.maxTotal);
      if (limit === null) continue;
      for (const asset of matched) {
        const actual = pickSize(asset, field);
        results.push(makeResult(budget, field, actual, limit, [asset.fileName], asset.fileName));
      }
      continue;
    }

    // ── ③ 总量模式 ──
    const limit = toLimit(budget.maxTotal ?? budget.maxGzip);
    if (limit === null) continue;
    const actual = matched.reduce((s, a) => s + pickSize(a, field), 0);
    results.push(makeResult(budget, field, actual, limit, matched.map((a) => a.fileName)));
  }

  return results;
}

function toLimit(input: string | number | undefined): number | null {
  if (input === undefined || input === null) return null;
  try {
    const n = parseSize(input);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

function makeResult(
  budget: Budget,
  field: BudgetField,
  actual: number,
  limit: number,
  offenders: string[],
  target?: string
): BudgetResult {
  const warnAt = budget.warnAt ?? 0.9;
  const r = limit > 0 ? actual / limit : 0;
  const level = r >= 1 ? 'error' : r >= warnAt ? 'warn' : 'ok';
  return {
    name: budget.name,
    level,
    actual,
    limit,
    field,
    ratio: r,
    offenders,
    target,
  };
}

/* ────────────────────── baseline ────────────────────── */

export interface Baseline {
  at: number;
  commit?: string;
  totalGzip: number;
  assets: Record<string, { raw: number; gzip: number; brotli: number }>;
}

export function buildBaseline(assets: AssetRecord[], commit?: string): Baseline {
  const record: Baseline['assets'] = {};
  let totalGzip = 0;
  for (const a of assets) {
    record[a.fileName] = { ...a.size };
    totalGzip += a.size.gzip;
  }
  return { at: Date.now(), commit, totalGzip, assets: record };
}

export interface DiffResult {
  deltas: BaselineDelta[];
  increaseRatio: number;
  increaseLimit: number;
  ok: boolean;
  newAssets: string[];
  removedAssets: string[];
}

export function diffBaseline(
  previous: Baseline,
  current: AssetRecord[],
  increaseLimitInput: string | number = 0.05,
  field: BudgetField = 'gzip'
): DiffResult {
  const limit = parseRatio(increaseLimitInput);
  const deltas: BaselineDelta[] = [];
  const newAssets: string[] = [];
  const removedAssets: string[] = [];

  let currentTotal = 0;
  for (const asset of current) {
    const now = asset.size[field];
    currentTotal += now;
    const before = previous.assets[asset.fileName]?.[field];
    if (before === undefined) {
      newAssets.push(asset.fileName);
      deltas.push({
        fileName: asset.fileName,
        field,
        before: 0,
        after: now,
        isNew: true,
        diff: now,
        ratio: Infinity,
      });
      continue;
    }
    deltas.push({
      fileName: asset.fileName,
      field,
      before,
      after: now,
      isNew: false,
      diff: now - before,
      ratio: before === 0 ? Infinity : (now - before) / before,
    });
  }

  for (const fileName of Object.keys(previous.assets)) {
    if (!current.some((a) => a.fileName === fileName)) removedAssets.push(fileName);
  }

  const previousTotal = previous.totalGzip;
  const increaseRatio =
    previousTotal === 0 ? 0 : (currentTotal - previousTotal) / previousTotal;

  return {
    deltas: deltas.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)),
    increaseRatio,
    increaseLimit: limit,
    // 总量下降视为通过；只有增长超过阈值才算失败
    ok: increaseRatio <= limit,
    newAssets,
    removedAssets,
  };
}
