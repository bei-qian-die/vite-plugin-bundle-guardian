import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AttributionCache, hashCode } from '../src/cache.js';
import { mergeOptions, findConfigFile, loadConfigFileSync, CONFIG_FILE_NAMES } from '../src/config.js';
import { extractImports, describeUsage } from '../src/usage.js';
import { estimateTransferMs, estimateImpact, readLighthouseReport, formatMs } from '../src/lighthouse.js';
import { appendHistory, readHistory, renderHistoryAscii, summarizeTrend } from '../src/history.js';
import { renderVscodeProblems, vscodeTaskSnippet } from '../src/report/vscode.js';
import { renderCompareHtml } from '../src/report/html.js';
import type { AnalysisResult } from '../src/types.js';

let tmp = '';
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(process.cwd(), '.tmp-feat-'));
});
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* ────────────────── 缓存 ────────────────── */

describe('AttributionCache · chunk hash 缓存', () => {
  const chunk = { fileName: 'assets/index.js', code: 'const a=1;'.repeat(50) };
  const attribution = {
    fileName: 'assets/index.js',
    totalBytes: 100,
    runtimeBytes: 10,
    degraded: false,
    bySource: [
      { source: '/app/src/main.ts', bytes: 60, resolved: { pkg: '@app', kind: 'app' as const, raw: '' } },
      { source: '/app/node_modules/lodash/i.js', bytes: 30, resolved: { pkg: 'lodash', kind: 'npm' as const, raw: '' } },
    ],
  };

  it('写入后能命中，第二次不再重算', () => {
    const dir = path.join(tmp, 'cache1');
    const cache = new AttributionCache(dir);
    cache.set(chunk, attribution);
    cache.save();

    const restored = new AttributionCache(dir);
    const hit = restored.get(chunk);
    expect(hit).not.toBeNull();
    expect(hit!.bySource).toEqual([
      ['/app/src/main.ts', 60],
      ['/app/node_modules/lodash/i.js', 30],
    ]);
    expect(restored.stats().hits).toBe(1);
  });

  it('产物内容变了（hash 变）就失效', () => {
    const dir = path.join(tmp, 'cache2');
    const cache = new AttributionCache(dir);
    cache.set(chunk, attribution);
    cache.save();

    const changed = { fileName: chunk.fileName, code: chunk.code + '/*changed*/' };
    expect(new AttributionCache(dir).get(changed)).toBeNull();
    expect(hashCode(chunk.code)).not.toBe(hashCode(changed.code));
  });

  it('缓存文件损坏时降级为不命中，不抛错', () => {
    const dir = path.join(tmp, 'cache3');
    fs.mkdirSync(path.join(dir, '.guardian'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.guardian', 'cache.json'), '{ broken', 'utf8');
    expect(new AttributionCache(dir).get(chunk)).toBeNull();
  });

  it('缓存落到 .guardian/cache.json', () => {
    const dir = path.join(tmp, 'cache4');
    const cache = new AttributionCache(dir);
    cache.set(chunk, attribution);
    cache.save();
    expect(fs.existsSync(path.join(dir, '.guardian', 'cache.json'))).toBe(true);
  });
});

/* ────────────────── 配置 ────────────────── */

describe('配置文件加载与合并', () => {
  it('能找到 .guardianrc.json', () => {
    const dir = path.join(tmp, 'cfg1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.guardianrc.json'), '{}', 'utf8');
    expect(findConfigFile(dir)).toBe(path.join(dir, '.guardianrc.json'));
    expect(CONFIG_FILE_NAMES[0]).toBe('.guardianrc.json');
  });

  it('loadConfigFileSync 读取并只保留认识的字段', () => {
    const dir = path.join(tmp, 'cfg2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.guardianrc.json'),
      JSON.stringify({
        budgets: [{ name: 'entry', maxTotal: '300 KB' }],
        failOnError: true,
        __垃圾字段__: '应该被丢弃',
      }),
      'utf8'
    );
    const loaded = loadConfigFileSync(dir)!;
    expect(loaded.options.budgets).toHaveLength(1);
    expect(loaded.options.failOnError).toBe(true);
    expect(loaded.options).not.toHaveProperty('__垃圾字段__');
  });

  it('内联优先，且内联的 undefined 不会覆盖配置', () => {
    const merged = mergeOptions(
      { failOnError: false, minPackageBytes: 1024 },
      { failOnError: true, minPackageBytes: undefined as unknown as number }
    );
    expect(merged.failOnError).toBe(true);   // 内联覆盖
    expect(merged.minPackageBytes).toBe(1024); // 内联没给 → 保留配置
  });

  it('budgets 按 name 合并去重，内联同名覆盖', () => {
    const merged = mergeOptions(
      { budgets: [{ name: 'a', maxTotal: '100 KB' }, { name: 'b', maxTotal: '200 KB' }] },
      { budgets: [{ name: 'b', maxTotal: '50 KB' }, { name: 'c', maxTotal: '30 KB' }] }
    );
    const names = merged.budgets!.map((b) => b.name).sort();
    expect(names).toEqual(['a', 'b', 'c']);
    expect(merged.budgets!.find((b) => b.name === 'b')!.maxTotal).toBe('50 KB');
  });

  it('rules / report / baseline 做浅合并', () => {
    const merged = mergeOptions(
      { rules: { 'unused-dep': 'warn' }, report: { html: 'dist/r.html' } },
      { rules: { 'heavy-package': 'off' }, report: { json: 'dist/r.json' } }
    );
    expect(Object.keys(merged.rules!).sort()).toEqual(['heavy-package', 'unused-dep']);
    expect(merged.report!.html).toBe('dist/r.html');
    expect(merged.report!.json).toBe('dist/r.json');
  });
});

/* ────────────────── 用法分析 ────────────────── */

describe('extractImports · 实际用到的导出', () => {
  it('具名导入', () => {
    const info = extractImports(`import { sortBy, debounce as db } from 'lodash';`, 'lodash');
    expect(info.named).toEqual(['sortBy', 'debounce']);
    expect(info.isWholePackage).toBe(false);
  });

  it('默认导入 = 整包引入', () => {
    const info = extractImports(`import _ from 'lodash';\n_.sortBy(a);`, 'lodash');
    expect(info.defaultAlias).toBe('_');
    expect(info.isWholePackage).toBe(true);
  });

  it('命名空间导入 = 整包引入', () => {
    const info = extractImports(`import * as echarts from 'echarts';`, 'echarts');
    expect(info.namespaceAlias).toBe('echarts');
    expect(info.isWholePackage).toBe(true);
  });

  it('默认 + 具名混合', () => {
    const info = extractImports(`import moment, { version } from 'moment';`, 'moment');
    expect(info.defaultAlias).toBe('moment');
    expect(info.named).toContain('version');
  });

  it('require 也算整包', () => {
    expect(extractImports(`const _ = require('lodash');`, 'lodash').viaRequire).toBe(true);
  });

  it('子路径导入视为按需', () => {
    const info = extractImports(`import sortBy from 'lodash/sortBy';`, 'lodash');
    expect(info.named).toContain('sortBy');
    expect(info.isWholePackage).toBe(false);
  });

  it('不误伤其它包的同名引用', () => {
    const info = extractImports(`import { a } from 'other-pkg';`, 'lodash');
    expect(info.named).toHaveLength(0);
  });

  it('describeUsage 给出可读摘要', () => {
    const info = extractImports(`import { sortBy, debounce } from 'lodash';`, 'lodash');
    expect(describeUsage(info)).toContain('sortBy');
  });
});

/* ────────────────── Lighthouse ────────────────── */

describe('Lighthouse 联动', () => {
  it('传输耗时换算：100KB 在 1.6Mbps 下约 0.5s', () => {
    const ms = estimateTransferMs(100 * 1024, 1600);
    expect(ms).toBeGreaterThan(400);
    expect(ms).toBeLessThan(600);
  });

  it('estimateImpact 给出前后差值', () => {
    const impact = estimateImpact(300 * 1024, 150 * 1024, 1600);
    expect(impact.savedMs).toBeGreaterThan(0);
    expect(impact.beforeMs).toBeGreaterThan(impact.afterMs);
  });

  it('读 Lighthouse JSON 报告', () => {
    const file = path.join(tmp, 'lh.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        categories: { performance: { score: 0.82 } },
        audits: { 'largest-contentful-paint': { numericValue: 2400 } },
      }),
      'utf8'
    );
    const lh = readLighthouseReport(file)!;
    expect(lh.score).toBe(82);
    expect(lh.lcpMs).toBe(2400);
  });

  it('文件不存在返回 null', () => {
    expect(readLighthouseReport(path.join(tmp, 'nope.json'))).toBeNull();
  });

  it('formatMs 在大数值时切到秒', () => {
    expect(formatMs(2400)).toContain('s');
    expect(formatMs(900)).toContain('ms');
  });
});

/* ────────────────── 历史趋势 ────────────────── */

describe('体积趋势历史', () => {
  it('追加并保留上限条数', () => {
    const file = path.join(tmp, 'h', 'history.json');
    for (let i = 0; i < 8; i++) {
      appendHistory(file, { at: Date.now() + i, totalGzip: 1000 + i * 100, assetCount: 3 }, 5);
    }
    const points = readHistory(file);
    expect(points).toHaveLength(5);
    expect(points[points.length - 1].totalGzip).toBe(1700);
  });

  it('趋势摘要给出首末差与峰值', () => {
    const trend = summarizeTrend([
      { at: 1, totalGzip: 1000, assetCount: 1 },
      { at: 2, totalGzip: 1500, assetCount: 1 },
      { at: 3, totalGzip: 800, assetCount: 1 },
    ])!;
    expect(trend.delta).toBe(-200);
    expect(trend.peak).toBe(1500);
    expect(trend.ratio).toBeCloseTo(-0.2);
  });

  it('ASCII 折线渲染不抛错且含图例', () => {
    const ascii = renderHistoryAscii([
      { at: 1, totalGzip: 1000, assetCount: 1, errors: 1 },
      { at: 2, totalGzip: 2000, assetCount: 1 },
    ]);
    expect(ascii).toContain('●');
    expect(ascii).toContain('!');
  });

  it('空历史时给出提示而不是报错', () => {
    expect(renderHistoryAscii([])).toContain('还没有历史记录');
  });
});

/* ────────────────── VSCode / 对比报告 ────────────────── */

function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    at: Date.now(),
    root: '/project',
    durationMs: 10,
    degraded: false,
    assets: [
      { fileName: 'assets/index.js', kind: 'chunk', ext: 'js', isEntry: true, size: { raw: 3000, gzip: 1000, brotli: 900 } },
    ],
    attribution: { totalBytes: 3000, runtimeBytes: 0, bySource: [], degraded: false },
    pkgs: [{ pkg: 'lodash', kind: 'npm', bytes: 1000, gzipBytes: 400, brotliBytes: 350, files: [], fileCount: 0, chunks: [] }],
    diagnostics: [
      { ruleId: 'heavy-package', level: 'error', pkg: 'lodash', msg: 'lodash 过大', where: '/project/src/a.ts:12', fix: '→ lodash-es' },
    ],
    budgets: [
      { name: 'entry', level: 'error', actual: 1000, limit: 500, field: 'gzip', ratio: 2, offenders: ['assets/index.js'] },
    ],
    ...overrides,
  };
}

describe('编辑器问题面板格式', () => {
  it('输出 path:line:col: severity: message [rule]', () => {
    const out = renderVscodeProblems(makeResult());
    expect(out).toContain('src/a.ts:12:1: error:');
    expect(out).toContain('[heavy-package]');
    expect(out).toContain('[budget/entry]');
  });

  it('配套的 tasks.json 是合法 JSON 且含 problemMatcher', () => {
    const json = JSON.parse(vscodeTaskSnippet());
    expect(json.tasks[0].problemMatcher.pattern.regexp).toContain('error|warning|info');
  });
});

describe('renderCompareHtml · before/after 对照报告', () => {
  it('输出单文件 HTML，含两张 treemap 与差异表', () => {
    const before = makeResult({ at: 1000 });
    const after = makeResult({
      at: 2000,
      assets: [
        { fileName: 'assets/index.js', kind: 'chunk', ext: 'js', isEntry: true, size: { raw: 1500, gzip: 500, brotli: 450 } },
      ],
      pkgs: [{ pkg: 'lodash-es', kind: 'npm', bytes: 500, gzipBytes: 100, brotliBytes: 90, files: [], fileCount: 0, chunks: [] }],
      diagnostics: [],
      budgets: [],
    });

    const html = renderCompareHtml(before, after);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('BEFORE');
    expect(html).toContain('AFTER');
    expect((html.match(/<svg/g) ?? []).length).toBe(2);
    expect(html).toContain('包级变化');
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});
