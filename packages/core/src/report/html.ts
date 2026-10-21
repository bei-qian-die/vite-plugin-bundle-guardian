/**
 * HTML Reporter —— 单文件、离线可打开的体积报告
 *
 * 约束：
 *  ① 不引任何 CDN / 外部字体 / 图表库，双击即可看
 *  ② treemap 用自研 squarify 渲染成内联 SVG
 *  ③ 视觉语言与「项目预览页」保持一致：工业实用风 + 单强调色
 */

import { formatBytes, formatPercent } from '../utils.js';
import { renderTreemapSvg } from './treemap.js';
import type { AnalysisResult, Diagnostic, PkgStat } from '../types.js';

/**
 * 概念图（MOCK 02）里的 treemap 是按**语义**着色的，不是按序号轮转色板：
 *   规则命中（待优化）= 深红 #C4241A   三方大包 = 朱红 #FF4A17
 *   三方小包          = 靛蓝 #2E45B8   业务源码 = 墨黑 #131612
 * 一眼就能看出「哪几块是问题所在」—— 这才是这张图的价值，实现必须跟上。
 */
const COLOR_HIT = '#C4241A';
const COLOR_VENDOR_BIG = '#FF4A17';
const COLOR_VENDOR_SMALL = '#2E45B8';
const COLOR_APP = '#131612';
const COLOR_RUNTIME = '#868C80';

/** 大包阈值：占总 gzip 5% 以上算「大包」 */
const BIG_PKG_RATIO = 0.05;

function treemapColor(pkg: PkgStat, totalGzip: number, hitPkgs: Set<string>): string {
  if (pkg.kind === 'app') return COLOR_APP;
  if (pkg.kind === 'runtime') return COLOR_RUNTIME;
  if (hitPkgs.has(pkg.pkg)) return COLOR_HIT;
  return pkg.gzipBytes / (totalGzip || 1) >= BIG_PKG_RATIO ? COLOR_VENDOR_BIG : COLOR_VENDOR_SMALL;
}

function renderLegend(): string {
  const items: Array<[string, string]> = [
    [COLOR_HIT, '规则命中 · 待优化'],
    [COLOR_VENDOR_BIG, '三方依赖 · 大包'],
    [COLOR_VENDOR_SMALL, '三方 · 小包'],
    [COLOR_APP, '业务源码'],
    [COLOR_RUNTIME, 'runtime / banner'],
  ];
  return `<div class="tm-legend">${items
    .map(([color, label]) => `<span><i style="background:${color}"></i>${label}</span>`)
    .join('')}</div>`;
}

/** 被规则命中的包（info 级不算问题） */
function collectHitPackages(result: AnalysisResult): Set<string> {
  const hits = new Set<string>();
  for (const d of result.diagnostics) {
    if (d.level !== 'info' && d.pkg) hits.add(d.pkg);
  }
  return hits;
}

export function renderHtml(result: AnalysisResult): string {
  const totalGzip = result.assets.reduce((s, a) => s + a.size.gzip, 0);
  const totalBrotli = result.assets.reduce((s, a) => s + a.size.brotli, 0);
  const maxAsset = result.assets[0];
  const failed = result.budgets.filter((b) => b.level === 'error');
  const hitPkgs = collectHitPackages(result);

  const treemapItems = result.pkgs
    .filter((p) => p.gzipBytes > 0)
    .slice(0, 18)
    .map((p) => ({
      name: p.pkg,
      value: Number((p.gzipBytes / 1024).toFixed(1)),
      color: treemapColor(p, totalGzip, hitPkgs),
    }));

  const legend = renderLegend();

  const treemap =
    treemapItems.length > 0
      ? renderTreemapSvg(treemapItems, { unit: 'KB' })
      : '<p style="color:#868C80">没有可用于可视化的归因数据（可能缺少 sourcemap）</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bundle Report · ${new Date(result.at).toLocaleString('zh-CN')}</title>
<style>
  :root{
    --bg:#F1F2EE; --surface:#FFFFFF; --surface2:#FAFAF7; --sunk:#F5F6F2;
    --ink:#131612; --ink2:#33382F; --muted:#5F665C; --line:#D9DBD2; --line2:#B4B8AC;
    --accent:#FF4A17; --accent-ink:#C22E08; --accent-wash:#FFF0EA;
    --ok:#0E6B4F; --ok-wash:#E5F3EE; --warn:#B87300; --warn-wash:#FDF3DF; --danger:#C4241A; --danger-wash:#FCEBE9;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.72;
       -webkit-font-smoothing:antialiased;padding:40px 20px}
  .wrap{max-width:1180px;margin:0 auto}
  header{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:28px}
  h1{font-size:1.9rem;letter-spacing:-.035em;margin:0 0 6px;font-weight:800}
  .meta{font-family:var(--mono);font-size:.72rem;color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-bottom:28px}
  .kpi{background:var(--surface);padding:16px 18px}
  .kpi b{display:block;font-size:1.75rem;letter-spacing:-.04em;line-height:1.15;font-variant-numeric:tabular-nums}
  .kpi b small{font-size:.45em;font-weight:600;color:var(--muted);letter-spacing:0}
  .kpi span{font-family:var(--mono);font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .kpi em{display:block;font-style:normal;font-family:var(--mono);font-size:.72rem;margin-top:2px}
  .up{color:var(--danger)} .down{color:var(--ok)}
  section{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:22px 24px;margin-bottom:20px}
  h2{font-size:1rem;margin:0 0 4px;letter-spacing:-.02em}
  .sub{font-size:.8rem;color:var(--muted);margin:0 0 16px}
  table{width:100%;border-collapse:collapse;font-size:.86rem}
  th{text-align:left;font-family:var(--mono);font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;
     color:var(--muted);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--line2)}
  td{padding:9px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
  td.r,th.r{text-align:right}
  tr:hover td{background:var(--surface2)}
  tr.bad td:first-child{color:var(--danger);font-weight:600}
  tr.bad{background:var(--danger-wash)}
  .tm-legend{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 14px;font-size:.78rem;color:var(--muted)}
  .tm-legend span{display:inline-flex;align-items:center;gap:6px}
  .tm-legend i{width:11px;height:11px;border-radius:2px;display:inline-block}
  .tag{display:inline-block;padding:0 6px;margin-left:6px;border-radius:3px;font-size:.68rem;line-height:1.6}
  .tag--danger{background:var(--danger-wash);color:var(--danger);border:1px solid var(--danger)}
  .fix{color:var(--ok);font-size:.8rem}
  .mono{font-family:var(--mono)}
  .bar{position:relative;height:6px;border-radius:3px;background:var(--sunk);overflow:hidden;min-width:80px}
  .bar i{position:absolute;left:0;top:0;bottom:0;background:var(--accent);border-radius:3px}
  .tag{display:inline-flex;font-family:var(--mono);font-size:.66rem;letter-spacing:.08em;
       padding:3px 7px;border-radius:3px;border:1px solid;white-space:nowrap}
  .t-err{color:var(--danger);border-color:rgba(196,36,26,.3);background:var(--danger-wash)}
  .t-warn{color:var(--warn);border-color:rgba(184,115,0,.3);background:var(--warn-wash)}
  .t-ok{color:var(--ok);border-color:rgba(14,107,79,.3);background:var(--ok-wash)}
  .diag{display:grid;gap:8px}
  .d{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;
     border:1px solid var(--line);border-left-width:3px;border-radius:4px;padding:11px 13px;background:var(--surface2);font-size:.86rem}
  .d.e{border-left-color:var(--danger)} .d.w{border-left-color:var(--warn)} .d.i{border-left-color:#2E45B8}
  .d b{font-family:var(--mono);font-size:.68rem;letter-spacing:.1em}
  .d.e b{color:var(--danger)} .d.w b{color:var(--warn)} .d.i b{color:#2E45B8}
  .d small{display:block;color:var(--muted);font-family:var(--mono);font-size:.72rem;margin-top:2px}
  .fix{font-family:var(--mono);font-size:.7rem;color:var(--ok);background:var(--ok-wash);
       border:1px solid rgba(14,107,79,.25);padding:4px 8px;border-radius:3px;white-space:nowrap}
  .tm{border:1px solid var(--line2);border-radius:4px;overflow:hidden;background:var(--sunk)}
  .banner{border-left:3px solid var(--warn);background:var(--warn-wash);padding:11px 14px;
          border-radius:4px;margin-bottom:20px;font-size:.86rem}
  footer{font-family:var(--mono);font-size:.72rem;color:var(--muted);text-align:center;padding-top:12px}
  @media (max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Bundle Report</h1>
    <div class="meta">vite-plugin-bundle-guardian · ${new Date(result.at).toLocaleString('zh-CN')} · ${result.assets.length} assets / ${result.pkgs.length} packages · analyzed in ${result.durationMs}ms${result.degraded ? ' · degraded' : ''}</div>
  </header>

  ${result.degraded ? '<div class="banner">⚠ 部分产物缺少 sourcemap，本次报告降级为「按模块原始大小估算」，归因精度不可控。建议在 <code>build.sourcemap = true</code> 下运行。</div>' : ''}

  <div class="kpis">
    <div class="kpi"><span>Total gzip</span><b>${compact(totalGzip)}</b><em class="${result.baseline && result.baseline.increaseRatio > 0 ? 'up' : 'down'}">${
      result.baseline ? formatPercent(result.baseline.increaseRatio) + ' vs baseline' : '—'
    }</em></div>
    <div class="kpi"><span>Total brotli</span><b>${compact(totalBrotli)}</b><em>−${((1 - totalBrotli / (result.assets.reduce((s, a) => s + a.size.raw, 0) || 1)) * 100).toFixed(1)}% vs raw</em></div>
    <div class="kpi"><span>Largest asset</span><b>${compact(maxAsset?.size.gzip ?? 0)}</b><em class="mono">${maxAsset?.fileName ?? '—'}</em></div>
    <div class="kpi"><span>Budget</span><b>${failed.length ? failed.length + ' <small>✖</small>' : 'PASS'}</b><em>${result.budgets.length} rules checked</em></div>
  </div>

  <section>
    <h2>Size attribution · 依赖体积分布（gzip）</h2>
    <p class="sub">基于 SourceMap 的字节级归因 · 面积 = gzip 体积 · 悬停查看精确值</p>
    ${legend}
    <div class="tm">${treemap}</div>
  </section>

  <section>
    <h2>Attribution · 归因明细</h2>
    <p class="sub">Top ${Math.min(14, result.pkgs.length)} 归因包 · 按 gzip 降序</p>
    <table>
      <thead><tr><th>包 / 模块</th><th>Version</th><th class="r">Gzip</th><th class="r">Share</th><th style="width:22%">占比</th><th>建议</th></tr></thead>
      <tbody>${packageRows(result, totalGzip)}</tbody>
    </table>
  </section>

  <section>
    <h2>Assets</h2>
    <p class="sub">按 gzip 降序</p>
    <table>
      <thead><tr><th>File</th><th class="r">Raw</th><th class="r">Gzip</th><th class="r">Brotli</th><th class="r">Δ base</th></tr></thead>
      <tbody>${assetRows(result)}</tbody>
    </table>
  </section>

  ${
    result.budgets.length > 0
      ? `<section>
    <h2>Budget</h2>
    <p class="sub">${formatBytes2(result.budgets.length)} 条预算规则</p>
    <table>
      <thead><tr><th>Budget</th><th class="r">Actual</th><th class="r">Limit</th><th class="r">Use</th><th>Status</th></tr></thead>
      <tbody>${budgetRows(result)}</tbody>
    </table>
  </section>`
      : ''
  }

  <section>
    <h2>Diagnostics</h2>
    <p class="sub">${result.diagnostics.length} 条</p>
    <div class="diag">${diagnosticRows(result.diagnostics)}</div>
  </section>

  <footer>Generated by vite-plugin-bundle-guardian · 无外部依赖，可离线打开</footer>
</div>
</body>
</html>`;
}

/* ────────────────── before / after 对比报告 ────────────────── */

/**
 * 把两次分析结果渲染成一份对照报告。
 * 治理效果靠两张 treemap 并排看最直观 —— 这也是给团队汇报时最有用的一屏。
 */
export function renderCompareHtml(before: AnalysisResult, after: AnalysisResult): string {
  const jsGzip = (r: AnalysisResult) =>
    r.assets.filter((a) => a.ext === 'js').reduce((s, a) => s + a.size.gzip, 0);
  const cssGzip = (r: AnalysisResult) =>
    r.assets.filter((a) => a.ext === 'css').reduce((s, a) => s + a.size.gzip, 0);

  const bJs = jsGzip(before);
  const aJs = jsGzip(after);
  const bCss = cssGzip(before);
  const aCss = cssGzip(after);
  const pct = (b: number, a: number) => (b === 0 ? 0 : ((a - b) / b) * 100);

  // 对照报告的两张 treemap 同样用语义配色，左右才可比
  const treemapOf = (r: AnalysisResult) => {
    const hits = collectHitPackages(r);
    const total = r.assets.reduce((s, a) => s + a.size.gzip, 0);
    const items = r.pkgs
      .filter((p) => p.gzipBytes > 0)
      .slice(0, 16)
      .map((p) => ({
        name: p.pkg,
        value: Number((p.gzipBytes / 1024).toFixed(1)),
        color: treemapColor(p, total, hits),
      }));
    return items.length > 0 ? renderTreemapSvg(items, { unit: 'KB', height: 300 }) : '<p>无归因数据</p>';
  };

  const afterMap = new Map(after.pkgs.map((p) => [p.pkg, p.gzipBytes]));
  const beforeMap = new Map(before.pkgs.map((p) => [p.pkg, p.gzipBytes]));
  const allPkgs = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const diffs = [...allPkgs]
    .map((pkg) => {
      const b = beforeMap.get(pkg) ?? 0;
      const a = afterMap.get(pkg) ?? 0;
      return { pkg, before: b, after: a, diff: a - b };
    })
    .sort((x, y) => x.diff - y.diff);

  const beforeIds = new Set(before.diagnostics.map((d) => `${d.ruleId}:${d.pkg ?? ''}`));
  const afterIds = new Set(after.diagnostics.map((d) => `${d.ruleId}:${d.pkg ?? ''}`));
  const resolved = [...beforeIds].filter((id) => !afterIds.has(id));
  const introduced = [...afterIds].filter((id) => !beforeIds.has(id));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bundle Compare · before vs after</title>
<style>${compareStyles()}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Bundle Compare</h1>
    <div class="meta">before ${new Date(before.at).toLocaleString('zh-CN')} · after ${new Date(after.at).toLocaleString('zh-CN')}</div>
  </header>

  <div class="kpis">
    <div class="kpi"><span>JS gzip</span><b>${compact(bJs)}</b><em class="down">→ ${compact(aJs)}</em></div>
    <div class="kpi"><span>JS 变化</span><b class="${pct(bJs, aJs) <= 0 ? 'good' : 'bad'}">${pct(bJs, aJs).toFixed(1)}%</b><em>${diffText(aJs - bJs)}</em></div>
    <div class="kpi"><span>CSS 变化</span><b class="${pct(bCss, aCss) <= 0 ? 'good' : 'bad'}">${pct(bCss, aCss).toFixed(1)}%</b><em>${compact(bCss)} → ${compact(aCss)}</em></div>
    <div class="kpi"><span>诊断</span><b>${before.diagnostics.length} → ${after.diagnostics.length}</b><em>已解决 ${resolved.length} 条</em></div>
  </div>

  <section>
    <h2>体积分布对照</h2>
    <p class="sub">左：治理前 · 右：治理后 · 面积 = gzip</p>
    <div class="pair">
      <div><div class="cap">BEFORE · ${compact(bJs)}</div>${treemapOf(before)}</div>
      <div><div class="cap">AFTER · ${compact(aJs)}</div>${treemapOf(after)}</div>
    </div>
  </section>

  <section>
    <h2>包级变化</h2>
    <p class="sub">按增量升序（最上面是省得最多的）</p>
    <table>
      <thead><tr><th>Package</th><th class="r">Before</th><th class="r">After</th><th class="r">Δ</th></tr></thead>
      <tbody>${diffs
        .slice(0, 16)
        .map(
          (d) => `<tr>
        <td class="mono">${esc(d.pkg)}</td>
        <td class="r mono">${formatBytes(d.before)}</td>
        <td class="r mono">${formatBytes(d.after)}</td>
        <td class="r mono ${d.diff < 0 ? 'down' : d.diff > 0 ? 'up' : ''}">${d.diff === 0 ? '—' : (d.diff > 0 ? '+' : '−') + formatBytes(Math.abs(d.diff))}</td>
      </tr>`
        )
        .join('')}</tbody>
    </table>
  </section>

  <section>
    <h2>诊断变化</h2>
    <div class="pair">
      <div>
        <div class="cap">已解决（${resolved.length}）</div>
        <ul class="list">${resolved.length ? resolved.map((id) => `<li>${esc(id.replace(/:$/, ''))}</li>`).join('') : '<li class="none">—</li>'}</ul>
      </div>
      <div>
        <div class="cap">新增（${introduced.length}）</div>
        <ul class="list">${introduced.length ? introduced.map((id) => `<li>${esc(id.replace(/:$/, ''))}</li>`).join('') : '<li class="none">—</li>'}</ul>
      </div>
    </div>
  </section>

  <footer>Generated by vite-plugin-bundle-guardian · compare · 单文件离线可打开</footer>
</div>
</body>
</html>`;
}

function diffText(delta: number): string {
  if (delta === 0) return '无变化';
  return (delta > 0 ? '+' : '−') + compact(Math.abs(delta));
}

function compareStyles(): string {
  return `
  :root{--ink:#131612;--muted:#5F665C;--line:#D9DBD2;--line2:#B4B8AC;--bg:#F1F2EE;--surface:#fff;--sunk:#F5F6F2;
    --ok:#0E6B4F;--danger:#C4241A;--accent:#FF4A17;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.7;padding:40px 20px}
  .wrap{max-width:1180px;margin:0 auto}
  header{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:24px}
  h1{font-size:1.8rem;letter-spacing:-.035em;margin:0 0 6px}
  h2{font-size:1rem;margin:0 0 4px}
  .sub{color:var(--muted);font-size:.8rem;margin:0 0 14px}
  .meta{font-family:var(--mono);font-size:.72rem;color:var(--muted);letter-spacing:.05em}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-bottom:20px}
  .kpi{background:var(--surface);padding:16px 18px}
  .kpi b{display:block;font-size:1.6rem;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
  .kpi b.good{color:var(--ok)} .kpi b.bad{color:var(--danger)}
  .kpi b small{font-size:.45em;font-weight:600;color:var(--muted)}
  .kpi span{font-family:var(--mono);font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .kpi em{display:block;font-style:normal;font-family:var(--mono);font-size:.72rem;margin-top:2px}
  section{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:22px 24px;margin-bottom:20px}
  .pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .cap{font-family:var(--mono);font-size:.7rem;letter-spacing:.1em;color:var(--muted);margin-bottom:6px}
  table{width:100%;border-collapse:collapse;font-size:.86rem}
  th{text-align:left;font-family:var(--mono);font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--line2)}
  td{padding:9px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
  td.r,th.r{text-align:right}
  .mono{font-family:var(--mono)}
  .up{color:var(--danger)} .down{color:var(--ok)}
  .list{margin:0;padding-left:18px;font-size:.85rem}
  .list .none{list-style:none;color:var(--muted);margin-left:-18px}
  footer{font-family:var(--mono);font-size:.72rem;color:var(--muted);text-align:center;padding-top:12px}
  @media (max-width:860px){.kpis{grid-template-columns:repeat(2,1fr)}.pair{grid-template-columns:1fr}}`;
}

function formatBytes2(n: number): string {
  return String(n);
}

function compact(bytes: number): string {
  if (bytes >= 1000 * 1000) return `${(bytes / 1000 / 1000).toFixed(2)}<small>MB</small>`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)}<small>KB</small>`;
  return `${bytes}<small>B</small>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 归因表。概念图里每一行末尾都有「→ lodash-es −82%」这样的修复建议 ——
 * 这是整个项目「不只是看图，而是给药方」的核心体现，表格里必须有。
 */
function packageRows(result: AnalysisResult, total: number): string {
  const rows = result.pkgs.filter((p) => p.gzipBytes > 0).slice(0, 14);
  if (rows.length === 0) return '<tr><td colspan="6" style="color:#868C80">无数据</td></tr>';

  const max = Math.max(...rows.map((r) => r.gzipBytes), 1);
  const hitPkgs = collectHitPackages(result);
  // 包名 → 该包命中规则时给出的修复建议
  const fixByPkg = new Map<string, string>();
  for (const d of result.diagnostics) {
    if (d.pkg && d.fix && !fixByPkg.has(d.pkg)) fixByPkg.set(d.pkg, d.fix);
  }

  return rows
    .map((p) => {
      const hit = hitPkgs.has(p.pkg);
      const color = treemapColor(p, total, hitPkgs);
      const fix = fixByPkg.get(p.pkg);
      return `<tr${hit ? ' class="bad"' : ''}>
      <td class="mono">${esc(p.pkg)}${hit ? '<span class="tag tag--danger">待优化</span>' : ''}</td>
      <td class="mono" style="color:#5F665C">${p.version ?? '—'}</td>
      <td class="r mono">${formatBytes(p.gzipBytes)}</td>
      <td class="r mono">${((p.gzipBytes / (total || 1)) * 100).toFixed(1)}%</td>
      <td><div class="bar"><i style="width:${((p.gzipBytes / max) * 100).toFixed(1)}%;background:${color}"></i></div></td>
      <td>${fix ? `<span class="fix">${esc(fix)}</span>` : '<span style="color:#5F665C">—</span>'}</td>
    </tr>`;
    })
    .join('');
}

function assetRows(result: AnalysisResult): string {
  const deltas = result.baseline
    ? new Map(result.baseline.deltas.map((d) => [d.fileName, d]))
    : null;
  return result.assets
    .slice(0, 20)
    .map((a) => {
      const d = deltas?.get(a.fileName);
      let deltaCell = '<span style="color:#868C80">—</span>';
      if (d) {
        deltaCell = d.isNew
          ? '<span style="color:#2E45B8">new</span>'
          : `<span class="${d.diff > 0 ? 'up' : d.diff < 0 ? 'down' : ''}">${formatPercent(d.ratio)}</span>`;
      }
      return `<tr>
      <td class="mono">${esc(a.fileName)}</td>
      <td class="r mono">${formatBytes(a.size.raw)}</td>
      <td class="r mono">${formatBytes(a.size.gzip)}</td>
      <td class="r mono">${formatBytes(a.size.brotli)}</td>
      <td class="r mono">${deltaCell}</td>
    </tr>`;
    })
    .join('');
}

function budgetRows(result: AnalysisResult): string {
  return result.budgets
    .map((b) => {
      const cls = b.level === 'error' ? 't-err' : b.level === 'warn' ? 't-warn' : 't-ok';
      const label = b.level === 'error' ? '✖ ERR' : b.level === 'warn' ? '⚠ WARN' : '✔ OK';
      return `<tr>
      <td class="mono">${esc(b.name)}${b.target ? ` <span style="color:#868C80">(${esc(b.target)})</span>` : ''}</td>
      <td class="r mono">${formatBytes(b.actual)}</td>
      <td class="r mono">${formatBytes(b.limit)}</td>
      <td class="r mono">${Math.round(b.ratio * 100)}%</td>
      <td><span class="tag ${cls}">${label}</span></td>
    </tr>`;
    })
    .join('');
}

function diagnosticRows(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return '<div class="d i"><b>INFO</b><span>没有发现需要治理的问题</span><span></span></div>';
  return diagnostics
    .slice(0, 24)
    .map((d) => {
      const cls = d.level === 'error' ? 'e' : d.level === 'warn' ? 'w' : 'i';
      return `<div class="d ${cls}">
      <b>${d.level.toUpperCase()}</b>
      <span>${esc(d.msg)}${d.where ? `<small>${esc(d.where)}</small>` : ''}</span>
      <span>${d.fix ? `<span class="fix">${esc(d.fix)}</span>` : ''}</span>
    </div>`;
    })
    .join('');
}
