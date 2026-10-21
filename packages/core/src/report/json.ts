/**
 * JSON Reporter —— 机器可读产物，用于 `bundle-guardian diff old.json new.json`
 * 以及 CI 里做自定义断言。
 */

import type { AnalysisResult } from '../types.js';

export interface JsonReport {
  tool: string;
  version: string;
  at: number;
  root: string;
  durationMs: number;
  degraded: boolean;
  summary: {
    assetCount: number;
    totalRaw: number;
    totalGzip: number;
    totalBrotli: number;
    errorCount: number;
    warnCount: number;
  };
  assets: Array<{
    fileName: string;
    kind: string;
    ext: string;
    isEntry: boolean;
    raw: number;
    gzip: number;
    brotli: number;
  }>;
  packages: Array<{
    pkg: string;
    version?: string;
    bytes: number;
    gzipBytes: number;
    brotliBytes: number;
    chunks: string[];
  }>;
  budgets: Array<{
    name: string;
    level: string;
    actual: number;
    limit: number;
    ratio: number;
    target?: string;
  }>;
  diagnostics: Array<{
    ruleId: string;
    level: string;
    pkg?: string;
    bytes?: number;
    msg: string;
    where?: string;
    fix?: string;
  }>;
  /** 模块依赖图，`bundle-guardian why <pkg>` 依赖它做离线链路回溯 */
  modules?: Array<{ id: string; importedIds: string[] }>;
  baseline?: {
    increaseRatio: number;
    increaseLimit: number;
    ok: boolean;
    deltas: Array<{ fileName: string; before: number; after: number; diff: number; ratio: number }>;
  };
}

export const TOOL_VERSION = '1.0.0';

export function toJson(result: AnalysisResult): JsonReport {
  return {
    tool: 'vite-plugin-bundle-guardian',
    version: TOOL_VERSION,
    at: result.at,
    root: result.root,
    durationMs: result.durationMs,
    degraded: result.degraded,
    summary: {
      assetCount: result.assets.length,
      totalRaw: result.assets.reduce((s, a) => s + a.size.raw, 0),
      totalGzip: result.assets.reduce((s, a) => s + a.size.gzip, 0),
      totalBrotli: result.assets.reduce((s, a) => s + a.size.brotli, 0),
      errorCount: result.diagnostics.filter((d) => d.level === 'error').length,
      warnCount: result.diagnostics.filter((d) => d.level === 'warn').length,
    },
    assets: result.assets.map((a) => ({
      fileName: a.fileName,
      kind: a.kind,
      ext: a.ext,
      isEntry: a.isEntry,
      raw: a.size.raw,
      gzip: a.size.gzip,
      brotli: a.size.brotli,
    })),
    packages: result.pkgs.map((p) => ({
      pkg: p.pkg,
      version: p.version,
      bytes: p.bytes,
      gzipBytes: p.gzipBytes,
      brotliBytes: p.brotliBytes,
      chunks: p.chunks,
    })),
    budgets: result.budgets.map((b) => ({
      name: b.name,
      level: b.level,
      actual: b.actual,
      limit: b.limit,
      ratio: Number(b.ratio.toFixed(4)),
      target: b.target,
    })),
    diagnostics: result.diagnostics.map((d) => ({
      ruleId: d.ruleId,
      level: d.level,
      pkg: d.pkg,
      bytes: d.bytes,
      msg: d.msg,
      where: d.where,
      fix: d.fix,
    })),
    modules: result.graph?.map((m) => ({ id: m.id, importedIds: m.importedIds })),
    baseline: result.baseline
      ? {
          increaseRatio: result.baseline.increaseRatio,
          increaseLimit: result.baseline.increaseLimit,
          ok: result.baseline.ok,
          deltas: result.baseline.deltas.map((d) => ({
            fileName: d.fileName,
            before: d.before,
            after: d.after,
            diff: d.diff,
            ratio: Number((Number.isFinite(d.ratio) ? d.ratio : 0).toFixed(4)),
          })),
        }
      : undefined,
  };
}

/** 对比两份 report.json，输出重建后的增量列表（CLI diff 用） */
export function diffReports(
  prev: JsonReport,
  next: JsonReport,
  topN = 10
): Array<{ key: string; before: number; after: number; diff: number; isNew: boolean }> {
  const beforeMap = new Map(prev.packages.map((p) => [p.pkg, p.gzipBytes]));
  const rows: Array<{ key: string; before: number; after: number; diff: number; isNew: boolean }> = [];

  for (const p of next.packages) {
    const before = beforeMap.get(p.pkg);
    rows.push({
      key: p.pkg,
      before: before ?? 0,
      after: p.gzipBytes,
      diff: p.gzipBytes - (before ?? 0),
      isNew: before === undefined,
    });
  }

  return rows.sort((a, b) => b.diff - a.diff).slice(0, topN);
}
