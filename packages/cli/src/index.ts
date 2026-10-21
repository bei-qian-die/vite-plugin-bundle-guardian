#!/usr/bin/env node
/**
 * bundle-guardian CLI（零第三方依赖）
 *
 *   bundle-guardian analyze [dir]   分析一次构建，产出终端/HTML/JSON/Markdown 报告
 *   bundle-guardian check   [dir]   走预算门禁，超限以 exit 1 退出（CI 用它）
 *   bundle-guardian why     <pkg>   打印最短引入链（需要 report.json 里的模块图）
 *   bundle-guardian diff <a> <b>    对比两份 report.json，输出增量 Top10
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  analyze,
  buildAdjacency,
  diffReports,
  emitReports,
  findRoots,
  findShortestPath,
  formatBytes,
  formatPercent,
  loadBaseline,
  loadConfigFile,
  mergeOptions,
  renderTerminal,
  renderHtml,
  renderCompareHtml,
  renderVscodeProblems,
  vscodeTaskSnippet,
  readLighthouseReport,
  estimateImpact,
  formatMs,
  readFileImports,
  describeUsage,
  appendHistory,
  readHistory,
  renderHistoryAscii,
  summarizeTrend,
  shouldFail,
  type AnalysisResult,
  type Baseline,
  type Bundle,
  type GuardianOptions,
  type JsonReport,
  type OutputItem,
} from '@bundle-guardian/core';

const HELP = `
  ██ bundle-guardian v1.0.0

  用法
    bundle-guardian analyze [dir]        分析构建产物（默认 dist）
    bundle-guardian check   [dir]        体积门禁，超限 exit 1
    bundle-guardian why     <pkg>        打印最短引入链 + 实际用到的导出
    bundle-guardian compare <a> <b>      两份 report.json 生成对照报告（HTML）
    bundle-guardian diff <old> <new>     对比两份 report.json 的包级增量
    bundle-guardian history              查看体积趋势（ASCII 折线）
    bundle-guardian vscode-task          输出配套的 VSCode tasks.json

  通用参数
    --budget <file>        预算配置（也可以放在 .guardianrc.json 里自动读取）
    --baseline <file>      baseline 路径，默认 .guardian/baseline.json
    --update-baseline      显式把本次结果写成新 baseline（默认不写）
    --increase-limit <pct> 允许的总量增幅，默认 5%
    --ci                   等价于 --fail-on-error，CI 环境自动开启
    --alias k=v,k=v        路径别名，离线扫描时还原 @/xxx 引用（why 需要）
    --json / --html / --md 指定报告输出路径
    --format vscode        额外输出编辑器问题面板格式
    --lighthouse <file>    读 Lighthouse 报告，换算传输耗时
    --record               把本次结果记进 .guardian/history.json
    --history <file>       history 文件路径，默认 .guardian/history.json
    --cache                开启归因结果缓存（chunk hash）
    --open                分析完打开 HTML 报告
    --quiet                不打印终端表格
    -h, --help             显示本帮助

  例子
    bundle-guardian check dist --ci --update-baseline --record
    bundle-guardian why lodash --report dist/__guardian/report.json
    bundle-guardian compare dist-before/__guardian/report.json dist-after/__guardian/report.json
`;

/* ────────────────────── 参数解析 ────────────────────── */

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'analyze', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, positional, flags };
}

/** 取字符串型 flag：给了 fallback 就一定返回 string */
function str(v: string | true | undefined, fallback: string): string;
function str(v: string | true | undefined, fallback?: string): string | undefined;
function str(v: string | true | undefined, fallback?: string): string | undefined {
  return typeof v === 'string' ? v : fallback;
}

const bool = (v: string | true | undefined): boolean => v === true || v === 'true';

/* ────────────────────── 从 dist 目录重建 Bundle ────────────────────── */

const SUPPORTED = /\.(js|mjs|cjs|css)$/;

function loadBundleFromDir(dir: string): Bundle {
  if (!fs.existsSync(dir)) {
    fail(`目录不存在：${dir}`);
  }
  const stat = fs.statSync(dir);
  const files = stat.isFile() ? [dir] : walk(dir);

  const bundle: Bundle = {};
  for (const file of files) {
    if (!SUPPORTED.test(file)) continue;
    if (file.endsWith('.map')) continue;

    const fileName = path.relative(stat.isFile() ? path.dirname(dir) : dir, file).replace(/\\/g, '/');
    const code = fs.readFileSync(file, 'utf8');

    if (/\.(js|mjs|cjs)$/.test(file)) {
      const mapPath = `${file}.map`;
      let map: unknown = null;
      if (fs.existsSync(mapPath)) {
        try {
          map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        } catch {
          map = null;
        }
      }
      bundle[fileName] = {
        type: 'chunk',
        fileName,
        code,
        map: map as never,
        // 没有 rollup 上下文，用启发式判断入口：sourcemap 里出现 main/entry/index 源文件
        isEntry: guessIsEntry(map as { sources?: string[] } | null),
      } as OutputItem;
    } else {
      bundle[fileName] = { type: 'asset', fileName, source: code };
    }
  }

  if (Object.keys(bundle).length === 0) {
    fail(`在 ${dir} 里没有找到任何 .js / .css 产物`);
  }
  return bundle;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function guessIsEntry(map: { sources?: string[] } | null): boolean {
  const sources = map?.sources ?? [];
  return sources.some((s) => /\/(main|entry|app|index)\.(ts|js|tsx|jsx|vue)$/.test(s));
}

/* ────────────────────── 选项组装 ────────────────────── */

/**
 * 组装选项：命令行 > 配置文件 > 默认值。
 * 只有用户显式给出的才会进 inline，避免默认值把配置文件里的设置盖掉。
 */
async function buildOptions(args: ParsedArgs): Promise<GuardianOptions> {
  const inline: GuardianOptions = {};

  const budgetFile = str(args.flags.budget);
  if (budgetFile) {
    if (!fs.existsSync(budgetFile)) fail(`预算文件不存在：${budgetFile}`);
    try {
      inline.budgets = JSON.parse(fs.readFileSync(budgetFile, 'utf8')) as GuardianOptions['budgets'];
    } catch (err) {
      fail(`预算文件解析失败：${(err as Error).message}`);
    }
  }

  inline.baseline = {
    file: str(args.flags.baseline, '.guardian/baseline.json'),
    increaseLimit: str(args.flags['increase-limit'], '5%'),
    // 只有显式 --update-baseline 才写基线，否则每次跑都会把超标"洗白"
    autoUpdate: bool(args.flags['update-baseline']),
  };

  inline.failOnError =
    bool(args.flags.ci) || bool(args.flags['fail-on-error']) || process.env.CI === 'true';

  const report: NonNullable<GuardianOptions['report']> = { terminal: !bool(args.flags.quiet) };
  const html = str(args.flags.html);
  const json = str(args.flags.json);
  const md = str(args.flags.md);
  if (html) report.html = html;
  if (json) report.json = json;
  if (md) report.markdown = md;
  if (bool(args.flags.open)) report.open = true;
  inline.report = report;

  if (str(args.flags.alias)) inline.alias = parseAlias(str(args.flags.alias), process.cwd());
  if (bool(args.flags.cache)) inline.cache = true;

  const root = process.cwd();
  const cfg = await loadConfigFile(root);
  const merged = mergeOptions(cfg?.options ?? {}, inline);

  // 三个输出都没指定时才套默认路径（否则用户只想要 json 却多出一堆文件）
  const r = merged.report ?? {};
  if (!r.html && !r.json && !r.markdown) {
    merged.report = {
      ...r,
      html: 'dist/__guardian/index.html',
      json: 'dist/__guardian/report.json',
      markdown: 'dist/__guardian/report.md',
    };
  }

  return merged;
}

/* ────────────────────── 命令实现 ────────────────────── */

async function runAnalyze(args: ParsedArgs): Promise<number> {
  const dir = args.positional[0] ?? 'dist';
  const options = await buildOptions(args);
  const bundle = loadBundleFromDir(dir);
  const root = process.cwd();

  const baselineFile = options.baseline?.file ?? '.guardian/baseline.json';
  const previousBaseline: Baseline | null = fs.existsSync(baselineFile)
    ? loadBaseline(baselineFile)
    : null;

  const result = await analyze({
    bundle,
    options,
    dependencies: readDependencies(root),
    previousBaseline,
    root,
    // 离线分析没有 Rollup 上下文，用源码扫描重建模块图，让 why 命令仍然可用
    distDir: path.resolve(dir),
    autoScan: true,
    alias: parseAlias(str(args.flags.alias), root),
  });

  if (options.report?.terminal !== false) console.log(renderTerminal(result));
  const emitted = emitReports(result, options);

  if (result.baseline && !result.baseline.ok) {
    console.log(`✖ 体积增量 ${formatPercent(result.baseline.increaseRatio)} 超过限制 ${formatPercent(result.baseline.increaseLimit)}`);
  }

  // --format vscode：给编辑器问题面板 / CI 注解用
  if (str(args.flags.format) === 'vscode') {
    console.log(renderVscodeProblems(result));
  }

  // --lighthouse：把体积换算成人能感知的传输耗时
  const lhFile = str(args.flags.lighthouse);
  if (lhFile) {
    const lh = readLighthouseReport(lhFile);
    const totalGzip = result.assets.reduce((s, a) => s + a.size.gzip, 0);
    const impact = estimateImpact(totalGzip, 0);
    console.log('\n LIGHTHOUSE');
    if (lh?.score !== undefined) {
      console.log(`   Performance ${lh.score}${lh.lcpMs ? ` · LCP ${formatMs(lh.lcpMs)}` : ''}`);
    }
    console.log(`   当前产物传输约 ${formatMs(impact.beforeMs)}（${Math.round(impact.kbps / 1000)} Mbps）`);
    const per100Kb = estimateImpact(100 * 1024, 0, impact.kbps).beforeMs;
    console.log(`   每省 100 KB ≈ 少 ${formatMs(per100Kb)} 传输时间\n`);
  }

  // --open：分析完直接打开 HTML 报告
  if (options.report?.open && emitted.html) openInBrowser(emitted.html);

  // --record：把本次结果记进趋势历史
  if (bool(args.flags.record)) {
    const historyFile = str(args.flags.history, '.guardian/history.json');
    appendHistory(historyFile, {
      at: Date.now(),
      totalGzip: result.assets.reduce((s, a) => s + a.size.gzip, 0),
      totalBrotli: result.assets.reduce((s, a) => s + a.size.brotli, 0),
      assetCount: result.assets.length,
      errors: result.budgets.filter((b) => b.level === 'error').length +
        result.diagnostics.filter((d) => d.level === 'error').length,
    });
    console.log(`✔ 已记录到 ${historyFile}`);
  }

  return shouldFail(result, options.failOnError) ? 1 : 0;
}

/* ────────────────────── history / compare ────────────────────── */

function runHistory(args: ParsedArgs): number {
  const file = str(args.flags.history, '.guardian/history.json');
  const points = readHistory(file);

  console.log(`\n ██ 体积趋势 · ${file}\n`);
  if (points.length === 0) {
    console.log(' 还没有历史记录。');
    console.log(' 先跑：bundle-guardian check dist --record\n');
    return 0;
  }

  console.log(renderHistoryAscii(points));
  const trend = summarizeTrend(points);
  if (trend) {
    const sign = trend.delta > 0 ? '▲ +' : trend.delta < 0 ? '▼ ' : '· ';
    console.log(
      `\n 区间变化：${(trend.first / 1024).toFixed(1)} KB → ${(trend.last / 1024).toFixed(1)} KB` +
        `  ${sign}${formatBytes(Math.abs(trend.delta))} (${formatPercent(trend.ratio)})`
    );
    console.log(` 峰值：${(trend.peak / 1024).toFixed(1)} KB\n`);
  }
  return 0;
}

function runCompare(args: ParsedArgs): number {
  const [oldFile, newFile] = args.positional;
  if (!oldFile || !newFile) fail('用法：bundle-guardian compare <before.json> <after.json> [--html out.html]');

  const before = readReport(oldFile);
  const after = readReport(newFile);
  const toResult = (r: JsonReport): AnalysisResult => fromJsonReport(r);

  const html = renderCompareHtml(toResult(before), toResult(after));
  const out = str(args.flags.html, 'bundle-compare.html');
  fs.mkdirSync(path.dirname(path.resolve(out)) || '.', { recursive: true });
  fs.writeFileSync(out, html, 'utf8');

  const dJs =
    after.summary.totalGzip -
    before.summary.totalGzip -
    (cssGzip(after) - cssGzip(before));
  console.log(`\n ██ before → after`);
  console.log(`   JS gzip  ${formatBytes(before.summary.totalGzip - cssGzip(before))} → ${formatBytes(after.summary.totalGzip - cssGzip(after))}`);
  console.log(`   CSS gzip ${formatBytes(cssGzip(before))} → ${formatBytes(cssGzip(after))}`);
  console.log(`   诊断     ${before.diagnostics.length} → ${after.diagnostics.length}`);
  console.log(`\n ✔ 对照报告已写入 ${out}\n`);
  void dJs;
  return 0;
}

function cssGzip(r: JsonReport): number {
  return r.assets.filter((a) => a.ext === 'css').reduce((s, a) => s + a.gzip, 0);
}

/**
 * 从 report.json 还原一个最小可用的 AnalysisResult。
 * 只填对比视图需要的字段，够用即可 —— 完整链路应该由插件侧直接传。
 */
function fromJsonReport(r: JsonReport): AnalysisResult {
  return {
    at: r.at,
    root: r.root,
    durationMs: r.durationMs,
    degraded: r.degraded,
    assets: r.assets.map((a) => ({
      fileName: a.fileName,
      kind: a.kind as 'chunk' | 'asset',
      ext: a.ext as 'js' | 'css' | 'map' | 'other',
      isEntry: a.isEntry,
      size: { raw: a.raw, gzip: a.gzip, brotli: a.brotli },
    })),
    attribution: { totalBytes: r.summary.totalRaw, runtimeBytes: 0, bySource: [], degraded: r.degraded },
    pkgs: r.packages.map((p) => ({
      pkg: p.pkg,
      version: p.version,
      kind: 'npm' as const,
      bytes: p.bytes,
      gzipBytes: p.gzipBytes,
      brotliBytes: p.brotliBytes,
      files: [],
      fileCount: 0,
      chunks: p.chunks,
    })),
    diagnostics: r.diagnostics.map((d) => ({
      ruleId: d.ruleId,
      level: d.level as 'error' | 'warn' | 'info',
      pkg: d.pkg,
      bytes: d.bytes,
      msg: d.msg,
      where: d.where,
      fix: d.fix,
    })),
    budgets: r.budgets.map((b) => ({
      name: b.name,
      level: b.level as 'ok' | 'warn' | 'error',
      actual: b.actual,
      limit: b.limit,
      field: 'gzip' as const,
      ratio: b.ratio,
      offenders: [],
      target: b.target,
    })),
    graph: r.modules,
  };
}

async function runCheck(args: ParsedArgs): Promise<number> {
  const code = await runAnalyze(args);
  return code;
}

function runWhy(args: ParsedArgs): number {
  const pkg = args.positional[0];
  if (!pkg) fail('用法：bundle-guardian why <pkg>');

  const reportFile = str(args.flags.report, 'dist/__guardian/report.json');
  if (!fs.existsSync(reportFile)) {
    fail(`找不到 ${reportFile}。先跑一次 analyze / build（需要插件把模块图写进 json）`);
  }

  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as JsonReport;
  const modules = report.modules ?? [];
  if (modules.length === 0) {
    fail('report.json 里没有模块图。请确认是由 vite-plugin-bundle-guardian 生成的报告。');
  }

  const adjacency = buildAdjacency(modules);
  const chain = findShortestPath(
    adjacency,
    (id) => id.includes(`node_modules/${pkg}/`) || id.includes(`node_modules/.pnpm/${pkg}@`),
    findRoots(adjacency, { preferApp: true })
  );

  const stat = report.packages.find((p) => p.pkg === pkg);

  console.log(`\n ██ 最短引入链 → ${pkg}\n`);
  if (!chain) {
    console.log(` 没有找到 ${pkg} 的引入链（它可能来自动态 import 或外部 CDN）\n`);
    return 0;
  }

  chain.forEach((id, i) => {
    console.log(` ${'  '.repeat(i)}${i > 0 ? '└─ ' : ''}${shorten(id)}`);
  });

  if (stat) {
    console.log(`\n 归因体积：gzip ${formatBytes(stat.gzipBytes)} · 命中 ${stat.chunks.length} 个产物`);
  }

  // 「你只用了几个方法却付了整个库的钱」—— 真正能推动优化的那一句
  const referrer = chain.length >= 2 ? chain[chain.length - 2] : null;
  const usage = referrer ? readFileImports(referrer.replace(/\?.*$/, ''), pkg) : null;
  if (usage) {
    console.log(`\n 实际用到：${describeUsage(usage)}`);
    if (usage.statements.length > 0) {
      usage.statements.forEach((s) => console.log(`   ${s}`));
    }
    if (usage.isWholePackage) {
      console.log(
        `\n ⚠ 整包导入，tree-shaking 难以生效 → 改成具名导入或子路径导入\n` +
          `   例：import { ${usage.named[0] ?? 'debounce'} } from '${pkg}'  或  import x from '${pkg}/${usage.named[0] ?? 'x'}'`
      );
    } else {
      console.log('\n ✔ 已是按需导入，体积基本没法从这里再省了');
    }
  }
  console.log('');
  return 0;
}

function runDiff(args: ParsedArgs): number {
  const [oldFile, newFile] = args.positional;
  if (!oldFile || !newFile) fail('用法：bundle-guardian diff <old.json> <new.json>');

  const prev = readReport(oldFile);
  const next = readReport(newFile);
  const rows = diffReports(prev, next, Number(args.flags.top ?? 10));

  console.log('\n PACKAGE DIFF (gzip)\n');
  console.log(' ' + padCol('PACKAGE', 32) + padCol('BEFORE', 12, true) + padCol('AFTER', 12, true) + padCol('Δ', 14, true));
  console.log(' ' + '─'.repeat(70));
  for (const row of rows) {
    const diff = row.diff >= 0 ? `+${formatBytes(row.diff)}` : `-${formatBytes(-row.diff)}`;
    console.log(
      ' ' +
        padCol(row.key + (row.isNew ? ' (new)' : ''), 32) +
        padCol(row.before ? formatBytes(row.before) : '—', 12, true) +
        padCol(formatBytes(row.after), 12, true) +
        padCol(diff, 14, true)
    );
  }
  console.log('');

  const totalBefore = prev.summary.totalGzip;
  const totalAfter = next.summary.totalGzip;
  console.log(
    ` TOTAL  ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)}  (${formatPercent(
      totalBefore === 0 ? 0 : (totalAfter - totalBefore) / totalBefore
    )})\n`
  );
  return 0;
}

/* ────────────────────── 工具 ────────────────────── */

function readReport(file: string): JsonReport {
  if (!fs.existsSync(file)) fail(`找不到报告文件：${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonReport;
  } catch (err) {
    fail(`报告解析失败：${(err as Error).message}`);
    throw err;
  }
}

/** 跨平台打开 HTML 报告，零依赖（不引 open 包） */
function openInBrowser(target: string): void {
  try {
    const command =
      process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = command === 'cmd' ? ['/c', 'start', '', target] : [target];
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打开失败不影响结果 */
  }
}

/** 解析 --alias "@date=src/utils/date.ts,@helper=src/utils/helper.ts" */
function parseAlias(input: string | undefined, root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const part of input.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    // 统一成绝对路径，扫描时才能命中
    out[key] = path.isAbsolute(value) ? value : path.resolve(root, value);
  }
  return out;
}

function readDependencies(root: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return { ...(pkg.dependencies ?? {}) };
  } catch {
    return {};
  }
}

function shorten(id: string): string {
  const idx = id.lastIndexOf('/node_modules/');
  return idx >= 0 ? `…${id.slice(idx)}` : path.relative(process.cwd(), id) || id;
}

function padCol(text: string, len: number, right = false): string {
  // 按显示宽度补齐（中文算 2 列）
  let width = 0;
  for (const ch of text) width += /[\u2E80-\uA4CF\uAC00-\uD7A3\uFF00-\uFF60]/.test(ch) ? 2 : 1;
  const pad = ' '.repeat(Math.max(0, len - width));
  return right ? pad + text : text + pad;
}

function fail(message: string): never {
  console.error(`\n ✖ ${message}\n`);
  process.exit(2);
}

/* ────────────────────── 入口 ────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === '-h' || args.command === '--help' || args.command === 'help') {
    console.log(HELP);
    return;
  }

  let code = 0;
  switch (args.command) {
    case 'analyze':
      code = await runAnalyze(args);
      break;
    case 'check':
      code = await runCheck(args);
      break;
    case 'why':
      code = runWhy(args);
      break;
    case 'diff':
      code = runDiff(args);
      break;
    case 'history':
      code = runHistory(args);
      break;
    case 'compare':
      code = runCompare(args);
      break;
    case 'vscode-task':
      console.log(vscodeTaskSnippet());
      break;
    default:
      console.log(HELP);
      code = 1;
  }

  process.exitCode = code;
}

main().catch((err) => {
  console.error(`\n ✖ ${(err as Error).message}\n`);
  process.exitCode = 2;
});
