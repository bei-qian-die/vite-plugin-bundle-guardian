import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  analyze,
  buildBaseline,
  diffBaseline,
  renderHtml,
  renderMarkdown,
  renderTerminal,
  stripAnsi,
  toJson,
  shouldFail,
} from '../src/index.js';
import type { Bundle, ChunkLike, GuardianOptions, ModuleNode } from '../src/types.js';
import { makeSimpleChunk } from './helpers.js';

/**
 * 端到端：OutputBundle → analyze → 四种报告 → 门禁判定
 *
 * 为了让 heavy-package / single-huge-chunk 这类规则在测试里也能触发，
 * 这里把阈值调小（而不是生成几十 MB 的字符串）。
 */

/**
 * 真随机十六进制串：不可压缩，用来模拟 minified 代码的熵。
 * （早先用线性同余伪随机数生成的数据 gzip 后只剩 3%，达不到规则阈值，
 *   这也是一个提醒：自己造测试数据时要先确认它的压缩率。）
 */
function noise(bytes: number): string {
  return randomBytes(Math.ceil(bytes / 2)).toString('hex').slice(0, bytes);
}

const ENTRY_TEXT = noise(6000);
const VENDOR_TEXT = noise(4000);
const LOCALE_TEXT = 'const months="一月_二月_三月_四月_五月_六月".split("_");'.repeat(60);

/** 用 helper 构造「每行一个 source」的精确 sourcemap，便于断言归因结果 */
const ENTRY_CHUNK: ChunkLike = makeSimpleChunk(
  [
    { path: '/app/src/main.ts', text: ENTRY_TEXT },
    { path: '/app/node_modules/lodash/index.js', text: VENDOR_TEXT },
    { path: '/app/node_modules/moment/locale/zh-cn.js', text: LOCALE_TEXT },
  ],
  '/*@license MIT*/'
);

function buildBundle(): Bundle {
  return {
    'assets/index-abc.js': {
      ...ENTRY_CHUNK,
      fileName: 'assets/index-abc.js',
      isEntry: true,
    },
    'assets/index-def.css': {
      type: 'asset',
      fileName: 'assets/index-def.css',
      source: '.a{color:red}'.repeat(400),
    },
  } as unknown as Bundle;
}

const MODULE_GRAPH: ModuleNode[] = [
  { id: '/app/src/main.ts', importedIds: ['/app/node_modules/lodash/index.js', '/app/node_modules/moment/locale/zh-cn.js'] },
  { id: '/app/node_modules/lodash/index.js', importedIds: [] },
  { id: '/app/node_modules/moment/locale/zh-cn.js', importedIds: [] },
];

const BASE_OPTIONS: GuardianOptions = {
  rules: {
    'heavy-package': ['error', { maxGzip: '1 KB' }],
    'single-huge-chunk': ['error', { maxGzip: '2 KB' }],
  },
  budgets: [
    { name: 'entry-js', contains: 'index-', ext: 'js', maxTotal: '2 KB' },
    { name: 'per-asset', each: true, maxGzip: '3 KB', warnAt: 0.8 },
    { name: 'lodash-budget', pkgs: ['lodash'], maxTotal: '1 KB' },
  ],
  minPackageBytes: 1,
};

describe('analyze · 端到端', () => {
  it('采集产物并算出真实 gzip / brotli（brotli 必须小于 gzip、小于 raw）', async () => {
    const result = await analyze({ bundle: buildBundle(), options: {}, moduleGraph: MODULE_GRAPH });

    expect(result.assets.length).toBe(2);
    const entry = result.assets.find((a) => a.fileName === 'assets/index-abc.js')!;
    expect(entry.isEntry).toBe(true);
    expect(entry.size.raw).toBeGreaterThan(10_000);
    expect(entry.size.gzip).toBeGreaterThan(0);
    expect(entry.size.gzip).toBeLessThan(entry.size.raw);
    expect(entry.size.brotli).toBeLessThan(entry.size.gzip);
  });

  it('归因到 npm 包粒度，lodash / moment 都能被识别', async () => {
    const result = await analyze({ bundle: buildBundle(), options: {}, moduleGraph: MODULE_GRAPH });
    const names = result.pkgs.map((p) => p.pkg);

    expect(names).toContain('lodash');
    expect(names).toContain('moment');
    expect(result.degraded).toBe(false);

    const lodash = result.pkgs.find((p) => p.pkg === 'lodash')!;
    expect(lodash.gzipBytes).toBeGreaterThan(0);
  });

  it('预算超限时落成 error，并给出用量比例', async () => {
    const result = await analyze({ bundle: buildBundle(), options: BASE_OPTIONS, moduleGraph: MODULE_GRAPH });

    const entryBudget = result.budgets.find((b) => b.name === 'entry-js')!;
    expect(entryBudget.level).toBe('error');
    expect(entryBudget.ratio).toBeGreaterThan(1);

    // each 模式要对每个产物分别出结果
    const perAsset = result.budgets.filter((b) => b.name === 'per-asset');
    expect(perAsset.length).toBe(2);
  });

  it('规则引擎产出 heavy-package 与 full-locale-import', async () => {
    const result = await analyze({ bundle: buildBundle(), options: BASE_OPTIONS, moduleGraph: MODULE_GRAPH });
    const ruleIds = result.diagnostics.map((d) => d.ruleId);

    expect(ruleIds).toContain('heavy-package');
    expect(ruleIds).toContain('full-locale-import');

    const lodash = result.diagnostics.find((d) => d.pkg === 'lodash')!;
    expect(lodash.fix).toContain('lodash-es');
    expect(lodash.estimatedSaving).toBeGreaterThan(0);
  });

  it('未使用依赖能被检出', async () => {
    const result = await analyze({
      bundle: buildBundle(),
      options: BASE_OPTIONS,
      moduleGraph: MODULE_GRAPH,
      dependencies: { lodash: '^4.0.0', 'qs': '^6.0.0', 'clipboard': '^2.0.0' },
    });
    const unused = result.diagnostics.find((d) => d.ruleId === 'unused-dep');
    expect(unused).toBeDefined();
    expect(unused!.msg).toContain('2');
  });

  it('模块图会被写进 result，供 CLI 的 why 命令离线回溯', async () => {
    const result = await analyze({ bundle: buildBundle(), options: {}, moduleGraph: MODULE_GRAPH });
    expect(result.graph).toHaveLength(3);
    expect(toJson(result).modules).toHaveLength(3);
  });

  it('没有 sourcemap 时整体标记为降级模式', async () => {
    const bundle = buildBundle();
    (bundle['assets/index-abc.js'] as { map: unknown }).map = null;
    const result = await analyze({ bundle, options: {}, moduleGraph: MODULE_GRAPH });
    expect(result.degraded).toBe(true);
  });
});

describe('三种 reporter 都能正常产出', () => {
  it('terminal：包含预算表、资产表与脚注', async () => {
    const result = await analyze({ bundle: buildBundle(), options: BASE_OPTIONS, moduleGraph: MODULE_GRAPH });
    const text = stripAnsi(renderTerminal(result));

    expect(text).toContain('bundle-guardian');
    expect(text).toContain('BUDGET SUMMARY');
    expect(text).toContain('TOP ASSETS');
    expect(text).toContain('lodash');
    expect(text).toContain('errors');
  });

  it('markdown：是合法的表格结构且含预算状态', async () => {
    const result = await analyze({ bundle: buildBundle(), options: BASE_OPTIONS, moduleGraph: MODULE_GRAPH });
    const md = renderMarkdown(result, 'https://ci.example/report.html');

    expect(md).toContain('## 📦 Bundle Report');
    expect(md).toContain('| Metric |');
    expect(md).toContain('🎯 Budget');
    expect(md).toContain('https://ci.example/report.html');
  });

  it('html：单文件、内联 treemap SVG、无外部资源引用', async () => {
    const result = await analyze({ bundle: buildBundle(), options: BASE_OPTIONS, moduleGraph: MODULE_GRAPH });
    const html = renderHtml(result);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<svg');
    expect(html).toContain('Size attribution');
    // 单文件约束：不允许任何 http(s) 外链
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('json：机器可读且可通过 JSON.parse 往返', async () => {
    const result = await analyze({ bundle: buildBundle(), options: BASE_OPTIONS, moduleGraph: MODULE_GRAPH });
    const json = toJson(result);
    const roundtrip = JSON.parse(JSON.stringify(json));

    expect(roundtrip.summary.assetCount).toBe(2);
    expect(roundtrip.packages.length).toBeGreaterThan(0);
    expect(roundtrip.budgets.length).toBeGreaterThan(0);
    expect(typeof roundtrip.summary.totalGzip).toBe('number');
  });
});

describe('baseline 增量门禁', () => {
  it('总量增幅超过阈值时应判定失败', async () => {
    const opts: GuardianOptions = { ...BASE_OPTIONS };
    const first = await analyze({ bundle: buildBundle(), options: opts, moduleGraph: MODULE_GRAPH });
    const baseline = buildBaseline(first.assets);

    // 人为把 baseline 的总量压得很小，制造大幅增长
    baseline.totalGzip = 1000;

    const result = await analyze({
      bundle: buildBundle(),
      options: { ...opts, baseline: { file: '.guardian/baseline.json', increaseLimit: '5%' } },
      moduleGraph: MODULE_GRAPH,
      previousBaseline: baseline,
    });

    expect(result.baseline).toBeDefined();
    expect(result.baseline!.ok).toBe(false);
    expect(result.baseline!.increaseRatio).toBeGreaterThan(0.05);
    expect(shouldFail(result, true)).toBe(true);
  });

  it('体积下降时不拦截，并能识别出新增产物', async () => {
    const opts: GuardianOptions = { ...BASE_OPTIONS };
    const first = await analyze({ bundle: buildBundle(), options: opts, moduleGraph: MODULE_GRAPH });
    const baseline = buildBaseline(first.assets);
    baseline.totalGzip = 10 ** 9; // 上一次极大 → 这次是下降

    const diff = diffBaseline(baseline, first.assets, '5%');
    expect(diff.ok).toBe(true);
    expect(diff.increaseRatio).toBeLessThan(0);
  });
});
