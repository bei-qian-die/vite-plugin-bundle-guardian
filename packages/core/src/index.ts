/**
 * @bundle-guardian/core
 *
 * 纯分析引擎：不依赖 Vite / Rollup 的运行时代码，只消费「产物 + sourcemap」。
 * 这样 CLI 能离线分析任意 rollup 产物，将来接 Webpack / Rspack / esbuild
 * 只需要再写一层 adapter —— 这是**依赖倒置**，工程化工具的通用范式。
 */

import fs from 'node:fs';
import path from 'node:path';

import { collectAssets } from './collect.js';
import { aggregatePackages, attributeChunk, type AnalyzedAsset, type ChunkAttribution } from './attribution.js';
import { resolveSource } from './pkg-resolve.js';
import { AttributionCache } from './cache.js';
import {
  buildBaseline,
  checkBudgets,
  diffBaseline,
  type Baseline,
  type DiffResult,
} from './budget.js';
import {
  buildAdjacency,
  findCircularDependencies,
  findDuplicatePackages,
  findRoots,
  findShortestPath,
  findUnusedDependencies,
} from './graph.js';
import {
  runRules,
  setCircularInput,
  setDuplicateInput,
  setUnusedInput,
} from './rules/index.js';
import { collectSourcePaths, scanModuleGraph } from './scan.js';
import { renderTerminal } from './report/terminal.js';
import { renderHtml } from './report/html.js';
import { renderMarkdown } from './report/markdown.js';
import { diffReports, toJson, type JsonReport } from './report/json.js';

import type {
  AnalysisResult,
  AssetRecord,
  Bundle,
  ChunkLike,
  GuardianOptions,
  ModuleNode,
  PkgStat,
} from './types.js';

export * from './types.js';
export { attributeChunk, aggregatePackages, RUNTIME_BUCKET } from './attribution.js';
export { decodeMappings, encodeVLQ, encodeSegment } from './vlq.js';
export { resolveSource, sourceBelongsTo } from './pkg-resolve.js';
export { squarify, renderTreemapSvg } from './report/treemap.js';
export { parseSize, parseRatio, formatBytes, formatPercent } from './utils.js';
export { measure, measureMany } from './compress.js';
export { collectAssets, detectExt, toBuffer } from './collect.js';
export * from './graph.js';
export { checkBudgets, buildBaseline, diffBaseline } from './budget.js';
export { builtinRules, runRules, REPLACEMENTS } from './rules/index.js';
export { renderTerminal, stripAnsi } from './report/terminal.js';
export { renderHtml, renderCompareHtml } from './report/html.js';
export { renderVscodeProblems, vscodeTaskSnippet } from './report/vscode.js';
export * from './lighthouse.js';
export * from './usage.js';
export * from './history.js';
export { renderMarkdown } from './report/markdown.js';
export { toJson, diffReports } from './report/json.js';
export { scanModuleGraph, collectSourcePaths } from './scan.js';
export { readPackageMeta, resetPackageMetaCache } from './pkg-meta.js';
export { AttributionCache, hashCode } from './cache.js';
export { loadConfigFile, loadConfigFileSync, mergeOptions, findConfigFile, CONFIG_FILE_NAMES } from './config.js';

/* ────────────────────────── 主流程 ────────────────────────── */

export interface AnalyzeInput {
  /** Rollup OutputBundle */
  bundle: Bundle;
  options?: GuardianOptions;
  /** 模块依赖图（来自插件上下文 this.getModuleInfo），用于环检测与 why */
  moduleGraph?: ModuleNode[];
  /** package.json 的 dependencies / devDependencies，用于未使用依赖检测 */
  dependencies?: Record<string, string>;
  /** 上一次的 baseline（由 loadBaseline 读入） */
  previousBaseline?: Baseline | null;
  /**
   * 离线场景（CLI 直接分析 dist）拿不到 moduleGraph 时，
   * 用 sourcemap 的 sources + 源码扫描重建一张近似图，让 `why` 命令可用。
   */
  autoScan?: boolean;
  /** 产物所在目录，用于解析 sourcemap 里的相对 source 路径 */
  distDir?: string;
  /** 路径别名（Vite 的 resolve.alias），离线扫描时用来还原 `@/xxx` 这类引用 */
  alias?: Record<string, string>;
  commit?: string;
  root?: string;
}

/**
 * 执行一次完整分析：采集 → 归因 → 图分析 → 规则 → 预算 → baseline
 */
export async function analyze(input: AnalyzeInput): Promise<AnalysisResult> {
  const started = Date.now();
  const options = input.options ?? {};
  const root = input.root ?? options.root ?? process.cwd();

  // ① 采集 + 真实压缩体积
  const assets = await collectAssets(input.bundle, {
    excludeMap: true,
    workers: options.workers,
  });

  // ② 逐 chunk 做字节级归因（开启缓存时先查 chunk hash，命中就跳过 VLQ 解码）
  const cache = options.cache ? new AttributionCache(root, { cacheDir: options.cacheDir }) : null;
  const analyzed: AnalyzedAsset[] = [];

  for (const asset of assets) {
    if (asset.kind !== 'chunk') continue;
    const chunk = input.bundle[asset.fileName] as ChunkLike | undefined;
    if (!chunk || typeof chunk.code !== 'string') continue;

    const hit = cache?.get(chunk);
    const attribution: ChunkAttribution = hit
      ? {
          fileName: hit.fileName,
          totalBytes: hit.totalBytes,
          runtimeBytes: hit.runtimeBytes,
          degraded: hit.degraded,
          // resolved 需要再跑一次 pkg-resolve：纯字符串运算，比解码便宜得多
          bySource: hit.bySource.map(([source, bytes]) => ({
            source,
            bytes,
            resolved: resolveSource(source),
          })),
        }
      : attributeChunk(chunk);

    if (!hit) cache?.set(chunk, attribution);
    analyzed.push({ asset, attribution });
  }
  cache?.save();

  // ③ 聚合成包维度
  const { pkgs, attribution } = aggregatePackages(analyzed);
  const visiblePkgs = filterPackages(pkgs, options.minPackageBytes);

  // ④ 依赖图：优先用插件给的精确图，否则（CLI 离线分析 dist）用源码扫描重建一张近似图
  let moduleNodes: ModuleNode[] = input.moduleGraph ?? [];
  if (moduleNodes.length === 0 && input.autoScan !== false) {
    // sourcemap 的 sources 是相对于「map 文件所在目录」的，
    // 产物常常在 dist/assets/ 下，直接用 dist/ 当基准会解析到错误路径。
    const sourcePaths = new Set<string>();
    for (const asset of assets) {
      const chunk = input.bundle[asset.fileName] as ChunkLike | undefined;
      const sources = chunk?.map?.sources;
      if (!sources) continue;
      const base = path.join(input.distDir ?? root, path.dirname(asset.fileName));
      for (const s of sources) {
        sourcePaths.add(path.isAbsolute(s) ? s : path.resolve(base, s));
      }
    }
    if (sourcePaths.size > 0) {
      moduleNodes = scanModuleGraph(sourcePaths, input.distDir ?? root, { alias: input.alias });
    }
  }
  const adjacency = buildAdjacency(moduleNodes);
  // preferApp：从业务源码起算，避免 why 直接停在第三方包内部
  const roots = moduleNodes.length > 0 ? findRoots(adjacency, { preferApp: true }) : [];

  const circular = adjacency.size > 0 ? findCircularDependencies(adjacency) : [];
  setCircularInput(circular);

  const duplicates = findDuplicatePackages(
    attribution_allSources(analyzed).map(({ resolved, bytes, source }) => ({
      pkg: resolved.pkg,
      version: resolved.version,
      file: source,
      bytes,
    }))
  );
  setDuplicateInput(
    duplicates.map((d) => ({
      pkg: d.pkg,
      versions: d.versions,
      estimatedBytes: d.estimatedBytes,
    }))
  );

  let unused: ReturnType<typeof findUnusedDependencies> = [];
  if (input.dependencies && Object.keys(input.dependencies).length > 0) {
    const detected = new Set<string>();
    for (const p of pkgs) if (p.kind === 'npm' && !p.pkg.startsWith('<')) detected.add(p.pkg);
    unused = findUnusedDependencies(input.dependencies, { detectedPkgs: detected });
  }
  setUnusedInput(unused);

  const resolveChain = (pkg: string): string[] | null => {
    if (adjacency.size === 0) return null;
    return findShortestPath(
      adjacency,
      (id) => id.includes(`node_modules/${pkg}/`) || id.includes(`node_modules/.pnpm/${pkg}@`),
      roots
    );
  };

  // ⑤ 规则引擎
  const diagnostics = runRules({
    assets,
    attribution,
    pkgs: visiblePkgs,
    options,
    resolveChain,
  });

  // ⑥ 预算 + baseline
  const budgets = checkBudgets({ assets, pkgs: visiblePkgs, budgets: options.budgets ?? [] });

  let baselineInfo: AnalysisResult['baseline'];
  if (input.previousBaseline) {
    const diff: DiffResult = diffBaseline(
      input.previousBaseline,
      assets,
      options.baseline?.increaseLimit ?? 0.05
    );
    baselineInfo = {
      file: options.baseline?.file ?? '.guardian/baseline.json',
      deltas: diff.deltas,
      increaseRatio: diff.increaseRatio,
      increaseLimit: diff.increaseLimit,
      ok: diff.ok,
    };
  }

  const degraded = analyzed.some((a) => a.attribution.degraded) || analyzed.length === 0;

  return {
    at: Date.now(),
    root,
    assets,
    attribution: {
      ...attribution,
      bySource: analyzed.flatMap((a) => a.attribution.bySource),
    },
    pkgs: visiblePkgs,
    diagnostics,
    budgets,
    baseline: baselineInfo,
    durationMs: Date.now() - started,
    degraded,
    graph: moduleNodes.length > 0 && moduleNodes.length <= GRAPH_LIMIT ? moduleNodes : undefined,
  };
}

/** 依赖图写入 report.json 的体积上限，防止巨型项目把报告撑爆 */
const GRAPH_LIMIT = 50_000;

function attribution_allSources(analyzed: AnalyzedAsset[]) {
  return analyzed.flatMap((a) => a.attribution.bySource);
}

function filterPackages(pkgs: PkgStat[], minBytes?: number): PkgStat[] {
  const min = minBytes ?? 512; // 默认过滤掉 < 512 B 的包，避免报告爆炸
  return pkgs.filter((p) => p.gzipBytes >= min);
}

/* ────────────────────────── 报告落盘 ────────────────────────── */

export interface EmittedReports {
  html?: string;
  json?: string;
  markdown?: string;
  baseline?: string;
}

export function emitReports(result: AnalysisResult, options: GuardianOptions = {}): EmittedReports {
  const emitted: EmittedReports = {};
  const report = options.report ?? {};

  const write = (target: string | false | undefined, content: string): string | undefined => {
    if (!target) return undefined;
    const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return abs;
  };

  emitted.html = write(report.html, renderHtml(result));
  emitted.json = write(report.json, JSON.stringify(toJson(result), null, 2));
  emitted.markdown = write(report.markdown, renderMarkdown(result));

  // baseline 默认**不自动写**：体积基线是团队共识，应该靠显式动作（--update-baseline）
  // 来更新，否则每次跑都会把上一次的超标"洗白"，门禁就形同虚设了。
  if (options.baseline?.file && options.baseline.autoUpdate === true) {
    write(options.baseline.file, JSON.stringify(buildBaseline(result.assets), null, 2));
    emitted.baseline = options.baseline.file;
  }

  return emitted;
}

/* ────────────────────────── baseline 读写 ────────────────────────── */

export function loadBaseline(file: string): Baseline | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    return parsed && typeof parsed.totalGzip === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/** 门禁判定：error 级预算 / 诊断 / baseline 超限时返回 false */
export function shouldFail(result: AnalysisResult, failOnError = true): boolean {
  if (!failOnError) return false;
  const budgetError = result.budgets.some((b) => b.level === 'error');
  const diagError = result.diagnostics.some((d) => d.level === 'error');
  const baselineError = result.baseline ? !result.baseline.ok : false;
  return budgetError || diagError || baselineError;
}

export function summary(result: AnalysisResult): string {
  const total = result.assets.reduce((s, a) => s + a.size.gzip, 0);
  return `${result.assets.length} assets · gzip ${(total / 1024).toFixed(1)} KB · ${result.pkgs.length} packages · ${result.durationMs}ms`;
}

export type { AssetRecord, Baseline, JsonReport, PkgStat };
