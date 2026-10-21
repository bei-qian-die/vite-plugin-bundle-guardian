/**
 * Terminal Reporter
 *
 * 零依赖自己实现 ANSI 着色（不要为了变色引入 picocolors），
 * 并在非 TTY / NO_COLOR 环境下自动降级为纯文本。
 */

import { formatBytes, formatPercent, padEnd, padStart } from '../utils.js';
import type { AnalysisResult, AssetRecord, BaselineDelta, BudgetResult, Diagnostic } from '../types.js';

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  Boolean(process.stdout?.isTTY ?? true);

function wrap(code: string) {
  return (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const C = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
  bgRed: wrap('41'),
};

export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*m/g, '');
}

const RULE_LINE = '─'.repeat(64);
const BLOCK = '██';

/* ────────────────────── 各区块 ────────────────────── */

export function renderHeader(result: AnalysisResult): string {
  const totalGzip = result.assets.reduce((s, a) => s + a.size.gzip, 0);
  const totalRaw = result.assets.reduce((s, a) => s + a.size.raw, 0);
  const lines = [
    '',
    `${C.red(BLOCK)} bundle-guardian ${C.dim(`root=${result.root}`)}`,
    `   ${C.dim(`assets ${result.assets.length} · gzip ${formatBytes(totalGzip)} · raw ${formatBytes(totalRaw)} · ${result.durationMs}ms`)}`,
    result.degraded ? `   ${C.yellow('⚠ sourcemap 缺失，已降级为「按模块原始大小估算」，归因精度不可控')}` : '',
    '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function renderBudgetTable(results: BudgetResult[], nameWidth = 26): string {
  if (results.length === 0) return '';
  const head = `${padEnd('BUDGET', nameWidth)}${padEnd('ACTUAL / LIMIT', 26)}${padStart('USE', 8)}   ST`;
  const rows = results.map((r) => {
    const actual = formatBytes(r.actual);
    const limit = formatBytes(r.limit);
    const use = `${Math.round(r.ratio * 100)}%`;
    const st = r.level === 'error' ? C.red('✖ ERR') : r.level === 'warn' ? C.yellow('⚠ WARN') : C.green('✔ OK');
    const bar = progressBar(r.ratio, r.level);
    // each 模式下 target 是完整产物路径，只取文件名避免撑破表格
    const target = r.target ? r.target.split('/').pop() : undefined;
    return ` ${padEnd(r.name + (target ? ` (${target})` : ''), nameWidth)}${padEnd(`${actual} / ${limit}`, 26)}${padStart(use, 8)}   ${st}\n   ${bar}`;
  });
  return [
    C.bold(' BUDGET SUMMARY'),
    C.gray(RULE_LINE),
    head,
    C.gray(RULE_LINE),
    rows.join('\n'),
    C.gray(RULE_LINE),
    '',
  ].join('\n');
}

function progressBar(ratio: number, level: 'ok' | 'warn' | 'error'): string {
  const total = 16;
  const filled = Math.max(0, Math.min(total, Math.round(ratio * total)));
  const color = level === 'error' ? C.red : level === 'warn' ? C.yellow : C.green;
  const bar = color(BLOCK.repeat(filled)) + C.gray('░'.repeat(total - filled));
  return bar;
}

export function renderAssetTable(
  assets: AssetRecord[],
  deltas?: Map<string, BaselineDelta>,
  limit = 8
): string {
  const head = ` ${padEnd('ASSET', 26)}${padStart('RAW', 11)}${padStart('GZIP', 11)}${padStart('BROTLI', 11)}${padStart('Δ BASE', 12)}`;
  const rows = assets.slice(0, limit).map((a) => {
    const delta = deltas?.get(a.fileName);
    let deltaText = C.gray('·  —');
    if (delta) {
      if (delta.isNew) deltaText = C.cyan('·  new');
      else if (Math.abs(delta.ratio) < 0.001) deltaText = C.gray('·   0%');
      else if (delta.ratio > 0) deltaText = C.red(`▲ +${formatPercent(delta.ratio)}`);
      else deltaText = C.green(`▼ ${formatPercent(delta.ratio)}`);
    }
    return ` ${padEnd(a.fileName, 26)}${padStart(formatBytes(a.size.raw), 11)}${padStart(formatBytes(a.size.gzip), 11)}${padStart(formatBytes(a.size.brotli), 11)}${padStart(deltaText, 12 + (deltaText.length - stripAnsi(deltaText).length))}`;
  });
  return [
    C.bold(' TOP ASSETS'),
    C.gray(RULE_LINE),
    head,
    C.gray(RULE_LINE),
    rows.join('\n'),
    C.gray(RULE_LINE),
    '',
  ].join('\n');
}

export function renderPackageTable(
  pkgs: { pkg: string; gzipBytes: number; version?: string }[],
  limit = 8
): string {
  if (pkgs.length === 0) return '';
  const total = pkgs.reduce((s, p) => s + p.gzipBytes, 0) || 1;
  const head = ` ${padEnd('PACKAGE', 26)}${padStart('GZIP', 11)}${padStart('SHARE', 10)}`;
  const rows = pkgs.slice(0, limit).map((p) => {
    const share = ((p.gzipBytes / total) * 100).toFixed(1) + '%';
    return ` ${padEnd(p.pkg + (p.version ? `@${p.version}` : ''), 26)}${padStart(formatBytes(p.gzipBytes), 11)}${padStart(share, 10)}`;
  });
  return [
    C.bold(' SIZE ATTRIBUTION (from sourcemap)'),
    C.gray(RULE_LINE),
    head,
    C.gray(RULE_LINE),
    rows.join('\n'),
    C.gray(RULE_LINE),
    '',
  ].join('\n');
}

export function renderDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return '';
  const icon = (level: string) =>
    level === 'error' ? C.red(' ✖') : level === 'warn' ? C.yellow(' ⚠') : C.blue(' ℹ');
  const rows = diagnostics.map((d) => {
    const parts = [
      `${icon(d.level)} ${C.bold(d.ruleId)}  ${C.gray(d.msg)}`,
    ];
    if (d.where) parts.push(`     ${C.gray(`↳ ${d.where}`)}`);
    if (d.fix) parts.push(`     ${C.green(d.fix)}${d.estimatedSaving ? C.gray(`   ≈ -${formatBytes(d.estimatedSaving)}`) : ''}`);
    return parts.join('\n');
  });
  return [C.bold(' DIAGNOSTICS'), C.gray(RULE_LINE), rows.join('\n'), C.gray(RULE_LINE), ''].join('\n');
}

export function renderFooter(result: AnalysisResult): string {
  const errors = result.diagnostics.filter((d) => d.level === 'error').length;
  const warns = result.diagnostics.filter((d) => d.level === 'warn').length;
  const infos = result.diagnostics.filter((d) => d.level === 'info').length;
  const budgetErrors = result.budgets.filter((b) => b.level === 'error').length;
  const budgetWarns = result.budgets.filter((b) => b.level === 'warn').length;

  const lines = [
    ` ${errors || budgetErrors ? C.red(`✖ ${errors + budgetErrors} errors`) : C.green('✔ 0 errors')} · ` +
      `${warns || budgetWarns ? C.yellow(`${warns + budgetWarns} warnings`) : '0 warnings'} · ` +
      `${C.blue(`${infos} info`)}  ${C.gray(`analyzed in ${result.durationMs} ms`)}`,
  ];

  const failed = errors + budgetErrors > 0;
  if (failed) {
    lines.push(` ${C.red('✖ Build rejected.')} ${C.gray('修复预算或更新 baseline 后再提交')}`);
  } else {
    lines.push(` ${C.green('✔ Budget passed.')}`);
  }

  if (result.baseline && !result.baseline.ok) {
    lines.push(
      ` ${C.red('✖ Baseline')} 总量增幅 ${formatPercent(result.baseline.increaseRatio)} > 限制 ${formatPercent(result.baseline.increaseLimit)}`
    );
  }

  return lines.join('\n') + '\n';
}

/** 生成完整终端报告 */
export function renderTerminal(result: AnalysisResult): string {
  const deltas = result.baseline
    ? new Map(result.baseline.deltas.map((d) => [d.fileName, d]))
    : undefined;

  return [
    renderHeader(result),
    renderBudgetTable(result.budgets),
    renderAssetTable(result.assets, deltas),
    renderPackageTable(result.pkgs),
    renderDiagnostics(result.diagnostics),
    renderFooter(result),
  ]
    .filter(Boolean)
    .join('\n');
}
