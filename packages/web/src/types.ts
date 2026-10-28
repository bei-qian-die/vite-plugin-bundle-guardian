/** 报告数据结构（与 @beiqiandie/core / CLI 输出的 JSON 对齐） */

export interface Asset {
  fileName: string;
  kind: string;
  ext: string;
  isEntry: boolean;
  raw: number;
  gzip: number;
  brotli: number;
}

export interface Pkg {
  pkg: string;
  version?: string;
  bytes: number;
  gzipBytes: number;
  brotliBytes: number;
  chunks: string[];
}

export interface Diagnostic {
  ruleId: string;
  level: string;
  bytes: number;
  msg: string;
  where: string;
  fix: string;
}

export interface ModuleNode {
  id: string;
  importedIds: string[];
}

export interface Budget {
  name: string;
  level: string;
  actual: number;
  limit: number;
  ratio: number;
}

export interface ReportSummary {
  assetCount: number;
  totalRaw: number;
  totalGzip: number;
  totalBrotli: number;
  errorCount: number;
  warnCount: number;
}

export interface Report {
  tool: string;
  version: string;
  at: number;
  root: string;
  durationMs: number;
  degraded: boolean;
  summary: ReportSummary;
  assets: Asset[];
  packages: Pkg[];
  budgets: Budget[];
  diagnostics: Diagnostic[];
  modules?: ModuleNode[];
}
