import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { measure, measureMany } from '../src/compress.js';
import { diffReports, toJson } from '../src/report/json.js';
import { emitReports, loadBaseline, shouldFail } from '../src/index.js';
import { buildBaseline } from '../src/budget.js';
import { analyze } from '../src/index.js';
import type { JsonReport } from '../src/report/json.js';

let tmp = '';

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(process.cwd(), '.tmp-infra-'));
});

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('compress · 并行压缩', () => {
  it('measure 单条：brotli 必须优于 gzip，gzip 优于 raw', () => {
    const text = 'const a = 1; '.repeat(500);
    const size = measure(text);
    expect(size.raw).toBe(Buffer.byteLength(text));
    expect(size.gzip).toBeLessThan(size.raw);
    expect(size.brotli).toBeLessThan(size.gzip);
  });

  it('measureMany 走 worker 池，结果与同步计算一致', async () => {
    const inputs = Array.from({ length: 6 }, (_, i) => ({
      key: `k${i}`,
      buf: Buffer.from(`payload-${i}-`.repeat(200 + i * 37)),
    }));
    const parallel = await measureMany(inputs, 3);
    expect(parallel.size).toBe(6);
    for (const input of inputs) {
      expect(parallel.get(input.key)!.gzip).toBe(measure(input.buf).gzip);
      expect(parallel.get(input.key)!.brotli).toBe(measure(input.buf).brotli);
    }
  }, 20000);

  it('worker 失败时降级为同步，结果仍然完整', async () => {
    // workers=1 会走同步分支，用来验证降级路径不丢数据
    const inputs = [{ key: 'a', buf: Buffer.from('hello'.repeat(100)) }];
    const out = await measureMany(inputs, 1);
    expect(out.get('a')!.gzip).toBe(measure(inputs[0].buf).gzip);
  });
});

describe('json · diffReports', () => {
  const base: JsonReport = {
    tool: 't', version: '1', at: 0, root: '/', durationMs: 1, degraded: false,
    summary: { assetCount: 1, totalRaw: 10, totalGzip: 100, totalBrotli: 90, errorCount: 0, warnCount: 0 },
    assets: [], budgets: [], diagnostics: [],
    packages: [
      { pkg: 'lodash', bytes: 1, gzipBytes: 100, brotliBytes: 90, chunks: [] },
      { pkg: 'vue', bytes: 1, gzipBytes: 50, brotliBytes: 45, chunks: [] },
      { pkg: 'gone', bytes: 1, gzipBytes: 30, brotliBytes: 25, chunks: [] },
    ],
  };

  it('按增量降序输出，新增包标 isNew', () => {
    const next: JsonReport = {
      ...base,
      packages: [
        { pkg: 'lodash', bytes: 1, gzipBytes: 40, brotliBytes: 35, chunks: [] },
        { pkg: 'vue', bytes: 1, gzipBytes: 130, brotliBytes: 120, chunks: [] },
      ],
    };
    const rows = diffReports(base, next, 10);
    expect(rows[0].key).toBe('vue');        // +80 最大
    expect(rows[0].diff).toBe(80);
    expect(rows.find((r) => r.key === 'lodash')!.diff).toBe(-60);
  });

  it('topN 生效', () => {
    expect(diffReports(base, base, 2)).toHaveLength(2);
  });
});

describe('报告落盘与门禁', () => {
  it('emitReports 写出 html/json/markdown 与 baseline', async () => {
    const bundle = {
      'assets/index.js': {
        type: 'chunk' as const,
        fileName: 'assets/index.js',
        code: 'const a=1;'.repeat(300),
        map: { version: 3, sources: ['/app/src/main.ts'], names: [], mappings: 'AAAA' },
        isEntry: true,
      },
    };
    const result = await analyze({
      bundle: bundle as never,
      options: { budgets: [{ name: 'all', maxTotal: '1 KB' }], autoScan: false },
    });

    const outDir = path.join(tmp, 'out');
    const emitted = emitReports(result, {
      report: {
        html: path.join(outDir, 'index.html'),
        json: path.join(outDir, 'report.json'),
        markdown: path.join(outDir, 'report.md'),
      },
      // baseline 只在显式 autoUpdate 时才写 —— 防止每次跑都把超标"洗白"
      baseline: { file: path.join(outDir, 'baseline.json'), autoUpdate: true },
    });

    expect(emitted.html && fs.existsSync(emitted.html)).toBe(true);
    expect(emitted.json && fs.existsSync(emitted.json)).toBe(true);
    expect(emitted.markdown && fs.existsSync(emitted.markdown)).toBe(true);
    expect(emitted.baseline && fs.existsSync(emitted.baseline)).toBe(true);

    const baseline = loadBaseline(path.join(outDir, 'baseline.json'));
    expect(baseline).not.toBeNull();
    expect(baseline!.totalGzip).toBeGreaterThan(0);
  });

  it('loadBaseline 对损坏文件返回 null 而不抛错', () => {
    const bad = path.join(tmp, 'broken.json');
    fs.writeFileSync(bad, '{ not json', 'utf8');
    expect(loadBaseline(bad)).toBeNull();
    expect(loadBaseline(path.join(tmp, 'nope.json'))).toBeNull();
  });

  it('shouldFail：预算 error 时返回 true，且 failOnError=false 时不拦', async () => {
    // 必须用不可压缩的数据：'x'.repeat(N) 的 gzip 只有几十字节，根本超不了 1 KB 预算
    const payload = randomBytes(20000).toString('hex');
    const bundle = {
      'assets/big.js': {
        type: 'chunk' as const,
        fileName: 'assets/big.js',
        code: payload,
        map: null,
        isEntry: true,
        modules: [{ id: '/app/src/main.ts', code: payload }],
      },
    };
    const result = await analyze({
      bundle: bundle as never,
      options: { budgets: [{ name: 'tiny', maxTotal: '1 KB' }], autoScan: false },
    });
    expect(result.budgets[0].level).toBe('error');
    expect(shouldFail(result, true)).toBe(true);
    expect(shouldFail(result, false)).toBe(false);
  });

  it('buildBaseline 记录的体积与资产一致', async () => {
    const bundle = {
      'assets/a.js': { type: 'chunk' as const, fileName: 'assets/a.js', code: 'a'.repeat(1000), map: null },
    };
    const result = await analyze({ bundle: bundle as never, options: {}, autoScan: false });
    const baseline = buildBaseline(result.assets, 'abc123');
    expect(baseline.commit).toBe('abc123');
    expect(baseline.assets['assets/a.js'].gzip).toBe(result.assets[0].size.gzip);
    expect(toJson(result).packages).toBeDefined();
  });
});
