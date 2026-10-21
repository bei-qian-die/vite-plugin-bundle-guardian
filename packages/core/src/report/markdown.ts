/**
 * Markdown Reporter —— 供 GitHub Actions 贴到 PR 评论
 *
 * 结构刻意对齐 GitHub 的 Markdown 渲染习惯：
 * 总结表格 → 预算表 → 增量 Top3 → 诊断列表 → 下载链接。
 */

import { formatBytes, formatPercent } from '../utils.js';
import type { AnalysisResult } from '../types.js';

export function renderMarkdown(result: AnalysisResult, reportUrl?: string): string {
  const { assets, pkgs, budgets, diagnostics, baseline } = result;

  const totalGzip = assets.reduce((s, a) => s + a.size.gzip, 0);
  const totalBrotli = assets.reduce((s, a) => s + a.size.brotli, 0);
  const baseGzip = baseline
    ? Object.values(baseline.deltas).reduce((s, d) => s + d.before, 0)
    : 0;

  const hasBase = Boolean(baseline);
  // 有 baseline 时表头是 4 列，每一行都要补齐单元格，否则 GitHub 渲染会错位
  const row = (cells: string[]) =>
    '| ' + cells.join(' | ') + ' |' + (hasBase ? ' |'.repeat(Math.max(0, 4 - cells.length)) : '');

  const out: string[] = [];

  const status = budgets.some((b) => b.level === 'error') ? '🚫' : '✅';
  out.push(`## 📦 Bundle Report ${status} — build ${result.at}`);
  out.push('');
  out.push(hasBase ? '| Metric | Base | This | Δ |' : '| Metric | Value |');
  out.push(hasBase ? '| --- | --- | --- | --- |' : '| --- | --- |');
  if (baseline) {
    out.push(row(['Total gzip', formatBytes(baseGzip), formatBytes(totalGzip), `**${delta(baseGzip, totalGzip)}**`]));
  } else {
    out.push(row(['Total gzip', formatBytes(totalGzip)]));
  }
  out.push(row(['Total brotli', formatBytes(totalBrotli)]));
  out.push(row(['Assets', String(assets.length)]));
  out.push(row(['Analysis', `${result.durationMs} ms`]));
  out.push('');

  // ── 预算 ──
  const failed = budgets.filter((b) => b.level !== 'ok');
  if (budgets.length > 0) {
    out.push('### 🎯 Budget');
    out.push('');
    out.push('| Budget | Limit | Actual | Use | Status |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const b of budgets) {
      out.push(
        `| \`${b.name}\` | ${formatBytes(b.limit)} | ${formatBytes(b.actual)} | ${Math.round(b.ratio * 100)}% | ${levelMark(b.level)} |`
      );
    }
    out.push('');
  }

  // ── 增量 Top3 ──
  if (baseline) {
    const top = baseline.deltas.filter((d) => d.diff > 0).slice(0, 3);
    if (top.length > 0) {
      out.push('### 🔍 增量 Top 3');
      out.push('');
      out.push('| Asset | Before | After | Δ |');
      out.push('| --- | --- | --- | --- |');
      for (const d of top) {
        out.push(
          `| \`${d.fileName}\` | ${d.isNew ? '—' : formatBytes(d.before)} | ${formatBytes(d.after)} | **${formatPercent(d.ratio)}** |`
        );
      }
      out.push('');
    }
  }

  // ── 体积归因 Top10 ──
  if (pkgs.length > 0) {
    out.push('### 📊 Size attribution (Top 10, gzip)');
    out.push('');
    out.push('| Package | Version | Gzip | Share | Suggestion |');
    out.push('| --- | --- | --- | --- | --- |');
    const top = pkgs.slice(0, 10);
    for (const p of top) {
      const fix = diagnostics.find((d) => d.pkg === p.pkg && d.fix);
      out.push(
        `| \`${p.pkg}\` | ${p.version ?? '—'} | ${formatBytes(p.gzipBytes)} | ${((p.gzipBytes / (totalGzip || 1)) * 100).toFixed(1)}% | ${fix?.fix ?? '—'} |`
      );
    }
    out.push('');
  }

  // ── 诊断 ──
  const significant = diagnostics.filter((d) => d.level !== 'info');
  if (significant.length > 0) {
    out.push('### 🩺 Diagnostics');
    out.push('');
    for (const d of significant.slice(0, 10)) {
      out.push(`- ${levelMark(d.level)} **${d.ruleId}** — ${d.msg}${d.fix ? ` → ${d.fix}` : ''}`);
    }
    out.push('');
  }

  out.push(
    `<sub>由 <code>vite-plugin-bundle-guardian</code> 生成 · ${new Date(result.at).toLocaleString('zh-CN')}${reportUrl ? ` · [下载完整 HTML 报告](${reportUrl})` : ''}</sub>`
  );

  return out.join('\n');
}

function levelMark(level: string): string {
  return level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅';
}

function delta(before: number, after: number): string {
  if (before === 0) return 'new';
  const r = (after - before) / before;
  const mark = r > 0 ? '⬆️' : r < 0 ? '⬇️' : '';
  return `${mark} ${formatPercent(r)}`;
}
