/**
 * 包元信息探测（带缓存）
 *
 * 用途：判断一个 npm 包**是否提供 ESM 入口**。
 * 这是 `cjs-bundled` 规则的判据 —— 光靠看产物路径里的 "cjs" / "commonjs" 字样是不行的：
 * lodash 的产物路径是 `node_modules/lodash/lodash.js`，一个 CJS 标记都没有，
 * 但它确实是纯 CJS 包、tree-shaking 完全失效。真正可靠的依据是包自己的 package.json。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface PackageMeta {
  name?: string;
  /** 是否提供 ESM 入口（type=module / module 字段 / exports.import） */
  hasEsm: boolean;
  main?: string;
  /** 探测失败（包不在磁盘上 / 是虚拟包）时为 false */
  found: boolean;
}

const cache = new Map<string, PackageMeta>();

export function readPackageMeta(pkg: string, root: string): PackageMeta {
  const key = `${root}::${pkg}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let meta: PackageMeta = { found: false, hasEsm: false };
  try {
    // pnpm 下 node_modules/<pkg> 是指向 .pnpm store 的软链，readFileSync 可直接穿过
    const dir = path.join(root, 'node_modules', pkg);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    meta = {
      found: true,
      name: typeof raw.name === 'string' ? raw.name : pkg,
      // package.json 里没写 module/exports 不代表没有 ESM：
      // dayjs 就是靠一个 esm/ 目录提供 ESM 的，得再扫一眼目录
      hasEsm: detectEsmEntry(raw) || detectEsmFiles(dir),
      main: typeof raw.main === 'string' ? raw.main : undefined,
    };
  } catch {
    meta = { found: false, hasEsm: false };
  }

  cache.set(key, meta);
  return meta;
}

function detectEsmEntry(raw: Record<string, unknown>): boolean {
  if (raw.type === 'module') return true;
  if (typeof raw.module === 'string') return true;

  const exportsField = raw.exports;
  if (exportsField) {
    const scan = (value: unknown): boolean => {
      if (typeof value === 'string') return /\.(mjs|esm\.js)$|\/esm\//.test(value);
      if (Array.isArray(value)) return value.some(scan);
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.import) return true;
        return Object.values(record).some(scan);
      }
      return false;
    };
    if (scan(exportsField)) return true;
  }

  return false;
}

/** 目录里有 esm/ 或 .mjs，也算提供了 ESM（dayjs 就是这种形态） */
function detectEsmFiles(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some((entry) => {
      if (entry.isDirectory()) return entry.name === 'esm' || entry.name === 'es';
      return entry.isFile() && entry.name.endsWith('.mjs');
    });
  } catch {
    return false;
  }
}

/** 清空缓存（测试用） */
export function resetPackageMetaCache(): void {
  cache.clear();
}
