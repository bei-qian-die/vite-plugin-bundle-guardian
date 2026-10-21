#!/usr/bin/env node
/**
 * 文档数字一键导出
 *
 * 背景：README / PLAN / 文章里的「治理收益」表是手工抄的，
 * 只要 playground 的页面代码有改动，构建产物就会变，表格立刻过期 ——
 * 之前已经因为改版漂过两次。这个脚本把「抄数字」变成「跑一下」，避免再对不上。
 *
 * 用法：
 *   node scripts/report-numbers.mjs              # 打印 markdown 表格
 *   node scripts/report-numbers.mjs --json        # 打印机器可读结果
 *
 * 前置：先跑 pnpm -F playground build（产出 dist-before / dist-after 两份报告）
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (mode) => {
  const file = path.join(root, 'playground', `dist-${mode}`, '__guardian', 'report.json');
  if (!fs.existsSync(file)) {
    console.error(`缺少 ${file}\n先跑：pnpm -F playground build`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const sumBy = (report, ext) =>
  report.assets.filter((a) => a.ext === ext).reduce((s, a) => s + a.gzip, 0);

const pkgMap = (report) =>
  Object.fromEntries(report.packages.map((p) => [p.pkg, p.gzipBytes / 1024]));

const kb = (n) => n / 1024;
const one = (n) => n.toFixed(1);
const pct = (before, after) => ((1 - after / before) * 100).toFixed(1);

const before = read('before');
const after = read('after');

const bjs = sumBy(before, 'js');
const ajs = sumBy(after, 'js');
const bcss = sumBy(before, 'css');
const acss = sumBy(after, 'css');

const bp = pkgMap(before);
const ap = pkgMap(after);
const row = (pkg) => ({ before: bp[pkg] ?? 0, after: ap[pkg] ?? 0 });

const result = {
  generatedFrom: {
    before: path.relative(root, 'playground/dist-before/__guardian/report.json'),
    after: path.relative(root, 'playground/dist-after/__guardian/report.json'),
  },
  js: { before: kb(bjs), after: kb(ajs), drop: Number(pct(bjs, ajs)) },
  css: { before: kb(bcss), after: kb(acss), drop: Number(pct(bcss, acss)) },
  assets: { before: before.summary.assetCount, after: after.summary.assetCount },
  packages: {
    echarts: row('echarts'),
    elementPlus: row('element-plus'),
    zrender: row('zrender'),
    moment: row('moment'),
    lodash: row('lodash'),
    lodashEs: row('lodash-es'),
  },
  diagnostics: {
    before: {
      error: before.diagnostics.filter((d) => d.level === 'error').length,
      warn: before.diagnostics.filter((d) => d.level === 'warn').length,
    },
    after: {
      error: after.diagnostics.filter((d) => d.level === 'error').length,
      warn: after.diagnostics.filter((d) => d.level === 'warn').length,
    },
  },
  durationMs: before.durationMs,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const d = (x) =>
  x > 0 ? `+${x.toFixed(1)}` : x < 0 ? `−${Math.abs(x).toFixed(1)}` : '0.0';

console.log(`<!-- 由 scripts/report-numbers.mjs 生成，请勿手改 -->`);
console.log('');
console.log('| 指标 | before | after | 变化 |');
console.log('| --- | ---: | ---: | ---: |');
console.log(`| **JS gzip 总计** | ${one(result.js.before)} KB | ${one(result.js.after)} KB | **−${result.js.drop}%** |`);
console.log(`| **CSS gzip** | ${one(result.css.before)} KB | ${one(result.css.after)} KB | **−${result.css.drop}%** |`);
console.log(`| 产物数 | ${result.assets.before} | ${result.assets.after} | 分包合理 |`);
console.log(`| echarts（归因） | ${one(bp.echarts ?? 0)} KB | ${one(ap.echarts ?? 0)} KB | −${one((bp.echarts ?? 0) - (ap.echarts ?? 0))} KB |`);
console.log(`| moment → dayjs | ${one(bp.moment ?? 0)} KB | 0 | −${one(bp.moment ?? 0)} KB |`);
console.log(
  `| lodash（CJS 全量） | ${one(bp.lodash ?? 0)} KB | 0（lodash-es ${one(ap['lodash-es'] ?? 0)} KB） | −${one((bp.lodash ?? 0) - (ap['lodash'] ?? 0))} KB |`
);
console.log(`| zrender（多版本重复） | ${one(bp.zrender ?? 0)} KB | ${one(ap.zrender ?? 0)} KB | ${d((ap.zrender ?? 0) - (bp.zrender ?? 0))} KB |`);
console.log(`| element-plus | ${one(bp['element-plus'] ?? 0)} KB | ${one(ap['element-plus'] ?? 0)} KB | ${d((ap['element-plus'] ?? 0) - (bp['element-plus'] ?? 0))} KB |`);
console.log('');
console.log(
  `规则诊断：${result.diagnostics.before.error} err / ${result.diagnostics.before.warn} warn → ` +
    `${result.diagnostics.after.error} err / ${result.diagnostics.after.warn} warn`
);
