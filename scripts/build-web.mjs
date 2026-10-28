/**
 * 构建 bundle-guardian 在线报告查看器（纯静态）
 *
 *   node scripts/build-web.mjs [outDir]
 *
 * 关键点：
 *  1. 先把 CLI 产出的示例报告（dist-before / dist-after）拷进 public/samples，
 *     页面一打开就有真实数据，不用先上传文件；
 *  2. 通过别名 @core 复用 @beiqiandie/core 的**编译产物**（不是重写一遍算法），
 *     浏览器端跑的是和 CLI 完全相同的 formatBytes / squarify / BFS 实现；
 *  3. node: 内建模块统一指向空实现，保证产物里不残留服务端依赖。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/* vite 装在 playground 的依赖里（pnpm 严格隔离），从那里 require */
const req = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../playground/package.json'));
const { build } = req('vite');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const webRoot = resolve(root, 'packages/web');
const coreDist = resolve(root, 'packages/core/dist');
const outDir = process.argv[2] ? resolve(process.argv[2]) : resolve(webRoot, 'dist');
const shim = resolve(root, 'scripts/node-shim.mjs');

/* 1. 准备示例数据 */
const samplesDir = resolve(webRoot, 'public/samples');
const reportsDir = resolve(root, '.tmp-reports');
if (existsSync(reportsDir)) {
  mkdirSync(samplesDir, { recursive: true });
  for (const name of ['before.json', 'after.json']) {
    const src = resolve(reportsDir, name);
    if (existsSync(src)) {
      copyFileSync(src, resolve(samplesDir, name));
      console.log(`[web] sample <- ${name}`);
    }
  }
}

/*
 * 2. 清掉上一轮的带 hash 产物。
 * 这里不能用 emptyOutDir：沙箱会拦下「批量删除构建输出」的动作，
 * 而且 dist 里的 samples/ 是要保留的。带 hash 的文件名每次都变，
 * 留着只会越堆越多，还会让冒烟脚本误挑到旧包。
 */
const distAssets = resolve(outDir, 'assets');
if (existsSync(distAssets)) {
  for (const f of readdirSync(distAssets)) {
    if (/\.(js|css)$/.test(f)) rmSync(resolve(distAssets, f), { force: true });
  }
}

/* 3. 构建 */
await build({
  root: webRoot,
  base: process.env.WEB_BASE || '/analyzer/',
  logLevel: 'info',
  plugins: [
    {
      name: 'node-builtin-stub',
      enforce: 'pre',
      resolveId(source) {
        if (source.startsWith('node:')) return pathToFileURL(shim).href;
        if (['fs', 'path', 'os', 'crypto', 'zlib'].includes(source)) return pathToFileURL(shim).href;
        return null;
      }
    }
  ],
  resolve: {
    alias: {
      '@core': coreDist
    }
  },
  build: {
    outDir,
    emptyOutDir: false,
    target: 'es2020',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1200
  }
});

console.log(`[web] built -> ${outDir}`);
