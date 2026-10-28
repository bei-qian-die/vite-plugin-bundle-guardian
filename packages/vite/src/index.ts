/**
 * Vite 适配层（刻意保持很薄）
 *
 * 这一层只干三件事：
 *   ① 在 generateBundle 里收集 Rollup 的产物与模块图，交给 core.analyze
 *   ② 在 writeBundle 里落盘报告，并按「预算 / 诊断 / baseline」做门禁
 *   ③ 在 dev / preview 起一个 /__guardian 面板
 *
 * 为什么要这么薄：**所有算法都在 core 里**，core 不认识 Vite。
 * CLI 因此能离线分析任意产物，将来接 Webpack / Rspack 只需再写一个同样的薄 adapter。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

import {
  analyze,
  buildAdjacency,
  emitReports,
  findRoots,
  findShortestPath,
  loadBaseline,
  loadConfigFileSync,
  mergeOptions,
  renderHtml,
  renderTerminal,
  shouldFail,
  toJson,
} from '@beiqiandie/core';
import type {
  AnalysisResult,
  Bundle,
  GuardianOptions,
  ModuleNode,
  OutputItem,
} from '@beiqiandie/core';

export type BundleGuardianOptions = GuardianOptions;

/** root 不在这里兜底：它必须来自 Vite 的 resolvedConfig */
const DEFAULTS: Pick<GuardianOptions, 'failOnError'> = {
  failOnError: false,
};

export function bundleGuardian(userOptions: GuardianOptions = {}): Plugin {
  const options: GuardianOptions = { ...DEFAULTS, ...userOptions };
  const devPath = options.devServer?.path ?? '/__guardian';

  let config: ResolvedConfig | null = null;
  let lastResult: AnalysisResult | null = null;

  return {
    name: 'bundle-guardian',
    enforce: 'post',

    configResolved(resolved) {
      config = resolved;

      // 配置文件（.guardianrc.json）→ 与内联选项合并，内联优先。
      // 这样团队可以把预算基线放进仓库，具体项目再按需覆盖。
      const cfg = loadConfigFileSync(resolved.root);
      const merged = mergeOptions(cfg?.options ?? {}, userOptions);
      Object.assign(options, { ...DEFAULTS, ...merged });

      options.root = options.root ?? resolved.root;
    },

    async generateBundle(_outputOptions, bundle) {
      if (!config) return;

      // ── ① 收集模块依赖图 ──
      // OutputChunk.modules 只有模块清单，没有 import 关系；
      // 真正的边要用 this.getModuleInfo(id).importedIds 拿，
      // 并按「产物里出现过的 id」过滤，避免把整棵 node_modules 全塞进来。
      const visibleIds = collectModuleIds(bundle);
      const moduleGraph: ModuleNode[] = [];
      for (const id of visibleIds) {
        const info = this.getModuleInfo(id);
        if (!info) continue;
        moduleGraph.push({
          id,
          importedIds: info.importedIds.filter((i) => visibleIds.has(i)),
        });
      }

      // ── ② 读取 baseline ──
      const baselineFile = options.baseline?.file ?? '.guardian/baseline.json';
      const previousBaseline = fs.existsSync(baselineFile)
        ? loadBaseline(baselineFile)
        : null;

      // ── ③ 分析 ──
      const result = await analyze({
        bundle: bundle as unknown as Bundle,
        options,
        moduleGraph,
        dependencies: readDependencies(options.root ?? process.cwd()),
        previousBaseline,
        root: config.root,
      });
      lastResult = result;

      if (options.report?.terminal !== false) {
        console.log(renderTerminal(result));
      }

      if (result.degraded && config.build.sourcemap !== true) {
        this.warn(
          '[bundle-guardian] 未开启 sourcemap，已降级为估算模式。请在 build.sourcemap = true 下运行以获得字节级精确归因。'
        );
      }
    },

    async writeBundle(outputOptions) {
      if (!lastResult || !config) return;

      const outDir = outputOptions.dir
        ? path.relative(process.cwd(), outputOptions.dir) || 'dist'
        : config.build.outDir;

      const reportTarget = {
        html: options.report?.html ?? path.join(outDir, '__guardian/index.html'),
        json: options.report?.json ?? path.join(outDir, '__guardian/report.json'),
        markdown: options.report?.markdown ?? path.join(outDir, '__guardian/report.md'),
      };

      emitReports(lastResult, {
        ...options,
        report: { terminal: false, ...reportTarget },
        baseline: { ...options.baseline, file: options.baseline?.file ?? '.guardian/baseline.json' },
      });

      if (options.report?.open && reportTarget.html) {
        openInBrowser(reportTarget.html as string);
      }

      if (shouldFail(lastResult, options.failOnError)) {
        const errors = [
          ...lastResult.budgets.filter((b) => b.level === 'error').map((b) => `预算 ${b.name} 超限`),
          ...lastResult.diagnostics
            .filter((d) => d.level === 'error')
            .map((d) => `${d.ruleId}: ${d.msg}`),
          lastResult.baseline && !lastResult.baseline.ok
            ? `体积增量 ${(lastResult.baseline.increaseRatio * 100).toFixed(1)}% 超过限制`
            : null,
        ].filter(Boolean) as string[];

        this.error(
          '[bundle-guardian] 构建被体积门禁拦截：\n  - ' + errors.join('\n  - ')
        );
      }
    },

    configureServer(server) {
      // 必须先注册更具体的路径：Express 风格中间件是前缀匹配，
      // `/__guardian` 会吃掉 `/__guardian/report.json`。
      server.middlewares.use(`${devPath}/report.json`, (_req, res) => {
        const body = lastResult ? JSON.stringify(toJson(lastResult)) : readLatestReport(server.config);
        if (!body) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end('{"error":"no report yet"}');
          return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });

      // 靶场页面需要同时拿到「治理前 / 治理后」两份报告来算真实降幅，
      // 否则 KPI 里的百分比只能写死，一旦重新构建就和产物对不上。
      for (const mode of ['before', 'after'] as const) {
        server.middlewares.use(`${devPath}/report-${mode}.json`, (_req, res) => {
          const file = path.resolve(server.config.root, `dist-${mode}`, '__guardian/report.json');
          let body: string | null = null;
          try {
            body = fs.readFileSync(file, 'utf8');
          } catch {
            /* 该模式还没构建过 */
          }
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          if (!body) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: `no dist-${mode} report` }));
            return;
          }
          res.end(body);
        });
      }

      server.middlewares.use(devPath, (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (lastResult) {
          res.end(renderHtml(lastResult));
          return;
        }
        // dev 态没有产物：直接回落到磁盘上最近一次构建生成的 HTML 报告，
        // 否则「打开完整报告」按钮只会看到一句"还没有构建产物"，体验断掉。
        const fallback = readLatestFile(server.config, '__guardian/index.html');
        res.end(
          fallback ??
            '<pre style="font:14px/1.6 monospace;padding:24px">还没有构建产物。\n先跑一次 `vite build`，或执行 `npx bundle-guardian analyze dist`。</pre>'
        );
      });
    },

    configurePreviewServer(server) {
      server.middlewares.use(devPath, (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(lastResult ? renderHtml(lastResult) : '<pre>无分析数据</pre>');
      });
    },
  };
}

/**
 * dev 态没有压缩产物，但 playground 页面需要展示真实数字。
 * 这里回落到磁盘上「最近一次构建」的 report.json ——
 * 依次找 build.outDir、dist-before、dist-after、dist。
 */
function readLatestReport(config: ResolvedConfig): string | null {
  return readLatestFile(config, '__guardian/report.json');
}

/** 依次在 outDir / dist-before / dist-after / dist 里找某个报告文件 */
function readLatestFile(config: ResolvedConfig, relative: string): string | null {
  const root = config.root;
  const candidates = [
    path.resolve(root, config.build.outDir, relative),
    path.resolve(root, 'dist-before', relative),
    path.resolve(root, 'dist-after', relative),
    path.resolve(root, 'dist', relative),
  ];
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

/** 跨平台打开浏览器，零依赖（不引 open 包） */
function openInBrowser(target: string): void {
  try {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = command === 'cmd' ? ['/c', 'start', '', target] : [target];
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打开失败不影响构建结果 */
  }
}

/** 从 OutputBundle 里收集所有出现过的模块 id */
function collectModuleIds(bundle: Record<string, OutputItem>): Set<string> {
  const ids = new Set<string>();
  for (const item of Object.values(bundle)) {
    if (item.type === 'asset') continue;
    const modules = (item as { modules?: Record<string, unknown> }).modules;
    if (!modules) continue;
    for (const id of Object.keys(modules)) ids.add(id);
  }
  return ids;
}

/** 读 package.json 的 dependencies / devDependencies，用于未使用依赖检测 */
function readDependencies(root: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return { ...(pkg.dependencies ?? {}) };
  } catch {
    return {};
  }
}

/* ────────────── 导出一些便捷能力给宿主项目用 ────────────── */

export interface WhyResult {
  pkg: string;
  chain: string[] | null;
}

/**
 * 在 Vite 环境里直接查某条依赖的引入链（CLI 之外的使用方式）。
 */
export function resolveChain(graph: ModuleNode[], pkg: string): WhyResult {
  const adjacency = buildAdjacency(graph);
  const chain = findShortestPath(
    adjacency,
    (id) => id.includes(`node_modules/${pkg}/`) || id.includes(`node_modules/.pnpm/${pkg}@`),
    findRoots(adjacency, { preferApp: true })
  );
  return { pkg, chain };
}

export default bundleGuardian;
