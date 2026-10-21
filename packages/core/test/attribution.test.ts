import { describe, expect, it } from 'vitest';
import { attributeChunk, aggregatePackages, RUNTIME_BUCKET } from '../src/attribution.js';
import { makeInterleavedChunk, makeSimpleChunk, type FakeSource } from './helpers.js';

const SOURCES: FakeSource[] = [
  { path: '/app/src/main.ts', text: 'const app=createApp(Root);app.mount("#app")' },
  { path: '/app/node_modules/lodash/merge.js', text: 'function merge(a,b){for(const k in b)a[k]=b[k];return a}' },
  { path: '/app/node_modules/moment/locale/zh-cn.js', text: 'export default{months:"一月_二月_三月_四月_五月_六月_七月".split("_")}' },
];

describe('attributeChunk · 字节级体积归因', () => {
  it('每个 source 得到完整的行字节数，且总量守恒', () => {
    const chunk = makeSimpleChunk(SOURCES);
    const result = attributeChunk(chunk);

    const totalAttrib = result.bySource.reduce((s, x) => s + x.bytes, 0);
    // 3 行 → 2 个换行符计入 runtime
    expect(result.runtimeBytes).toBe(2);
    expect(totalAttrib + result.runtimeBytes).toBe(result.totalBytes);
    expect(result.totalBytes).toBe(Buffer.byteLength(chunk.code));

    for (const s of SOURCES) {
      const item = result.bySource.find((x) => x.source === s.path);
      expect(item, `应归因到 ${s.path}`).toBeDefined();
      expect(item!.bytes).toBe(Buffer.byteLength(s.text));
    }
  });

  it('中文按 UTF-8 字节计，而不是 String.length', () => {
    const zh: FakeSource[] = [{ path: '/app/src/zh.ts', text: 'const s="体积治理"' }];
    const { path, text } = zh[0];
    const result = attributeChunk(makeSimpleChunk(zh));
    const item = result.bySource.find((x) => x.source === path)!;
    expect(item.bytes).toBe(Buffer.byteLength(text));
    expect(item.bytes).toBeGreaterThan(text.length); // 中文 UTF-8 是 3 字节/字
  });

  it('行内多 source 交织时精确切分（这是 sourcemap 归因的核心价值）', () => {
    const { chunk, expected } = makeInterleavedChunk(SOURCES, [0, 1, 2, 1, 0, 2]);
    const result = attributeChunk(chunk);

    expect(result.degraded).toBe(false);
    for (const [path, bytes] of expected) {
      const item = result.bySource.find((x) => x.source === path);
      expect(item).toBeDefined();
      expect(item!.bytes, `${path} 的归因字节`).toBe(bytes);
    }
    const total = result.bySource.reduce((s, x) => s + x.bytes, 0);
    expect(total + result.runtimeBytes).toBe(result.totalBytes);
  });

  it('未被映射的注入代码（banner / runtime）进入 runtime 桶', () => {
    const banner = '/*@license MIT*////# sourceMappingURL=x.js.map';
    const result = attributeChunk(makeSimpleChunk(SOURCES, banner));
    // 3 行 + banner：2 个 source 换行 + banner 行前的 1 个换行 + banner 自身
    expect(result.runtimeBytes).toBe(3 + Buffer.byteLength(banner));
  });

  it('缺少 sourcemap 时降级，并用 modules 原始长度等比折算', () => {
    const mods = SOURCES.map((s) => ({ id: s.path, code: s.text }));
    const chunk = {
      type: 'chunk' as const,
      fileName: 'index.js',
      code: 'x'.repeat(100),
      map: null,
      modules: mods,
    };
    const result = attributeChunk(chunk);
    expect(result.degraded).toBe(true);
    // 降级后各 source 之和应归一到产物实际体积（100 字节）
    const sum = result.bySource.reduce((s, x) => s + x.bytes, 0);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(2);
  });

  it('完全缺失 sourcemap 且无 modules 时，全部归 runtime 且不抛错', () => {
    const result = attributeChunk({ type: 'chunk', fileName: 'a.js', code: 'var a=1', map: null });
    expect(result.degraded).toBe(true);
    expect(result.runtimeBytes).toBeGreaterThan(0);
  });
});

describe('aggregatePackages · 按占比折算 gzip', () => {
  it('占一半字节的包应拿到大约一半的 gzip', () => {
    const half = 1000;
    const sources: FakeSource[] = [
      { path: '/app/node_modules/aaa/index.js', text: 'a'.repeat(half) },
      { path: '/app/node_modules/bbb/index.js', text: 'b'.repeat(half) },
    ];
    const chunk = makeSimpleChunk(sources);
    const attribution = attributeChunk(chunk);
    const asset = {
      fileName: 'index.js',
      kind: 'chunk' as const,
      ext: 'js' as const,
      isEntry: true,
      size: { raw: 2048, gzip: 1024, brotli: 900 },
    };

    const { pkgs } = aggregatePackages([{ asset, attribution }]);
    const aaa = pkgs.find((p) => p.pkg === 'aaa')!;
    const bbb = pkgs.find((p) => p.pkg === 'bbb')!;

    expect(aaa.pkg).toBe('aaa');
    expect(Math.abs(aaa.gzipBytes - 512)).toBeLessThanOrEqual(4);
    expect(Math.abs(bbb.gzipBytes - 512)).toBeLessThanOrEqual(4);
    expect(aaa.gzipBytes + bbb.gzipBytes).toBeLessThanOrEqual(1024 + 4);
  });

  it('runtime 桶单独统计，不混进任何真实包', () => {
    const result = attributeChunk(makeSimpleChunk(SOURCES, '/*banner*/'));
    const asset = {
      fileName: 'index.js',
      kind: 'chunk' as const,
      ext: 'js' as const,
      isEntry: true,
      size: { raw: 400, gzip: 200, brotli: 180 },
    };
    const { pkgs } = aggregatePackages([{ asset, attribution: result }]);
    expect(pkgs.some((p) => p.pkg === RUNTIME_BUCKET)).toBe(true);
    expect(pkgs.find((p) => p.pkg === RUNTIME_BUCKET)!.kind).toBe('runtime');
  });

  it('同名包的多个子路径会被合并统计', () => {
    const sources: FakeSource[] = [
      { path: '/app/node_modules/lodash/merge.js', text: 'a'.repeat(300) },
      { path: '/app/node_modules/lodash/cloneDeep.js', text: 'b'.repeat(300) },
    ];
    const attribution = attributeChunk(makeSimpleChunk(sources));
    const asset = {
      fileName: 'index.js', kind: 'chunk' as const, ext: 'js' as const, isEntry: true,
      size: { raw: 600, gzip: 300, brotli: 260 },
    };
    const { pkgs } = aggregatePackages([{ asset, attribution }]);
    const lodash = pkgs.find((p) => p.pkg === 'lodash')!;
    expect(lodash.fileCount).toBe(2);
    expect(lodash.files).toHaveLength(2);
    expect(lodash.gzipBytes).toBeGreaterThan(250);
  });
});
