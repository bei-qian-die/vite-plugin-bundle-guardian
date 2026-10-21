/**
 * SourceMap 的 source 路径 → npm 包名归一化
 *
 * 要处理三种包管理器的磁盘布局（这是很多自研工具最容易写错的一处）：
 *
 *  ┌ npm / yarn 扁平
 *  │  /app/node_modules/lodash/merge.js
 *  ├ npm 嵌套
 *  │  /app/node_modules/a/node_modules/lodash/merge.js
 *  └ pnpm（带版本 + content-addressable store 软链）
 *     /app/node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/merge.js
 *     /app/node_modules/.pnpm/@babel+runtime@7.24.0/node_modules/@babel/runtime/helpers/x.js
 *                            ↑ 注意 scope 包的 '+' 代替了 '/'
 *
 * 另外还要处理 Vite 特有的：
 *  - 带 query 的虚拟模块  /app/src/App.vue?vue&type=script&lang.ts
 *  - Rollup 内部模块      \0commonjsHelpers.js / rollupPluginBabelHelpers.js
 */

import type { ResolvedSource, SourceKind } from './types.js';

const NODE_MODULES = '/node_modules/';
const PNPM_STORE = /\.pnpm\/([^/]+)\/node_modules\//;

/** Rollup / Vite 注入的垫片模块，统一归到一个桶，避免污染 Top 包列表 */
const BUILD_HELPERS: RegExp[] = [
  /\0?commonjsHelpers\./,
  /\0commonjs-/,
  /rollupPluginBabelHelpers\./,
  /\0vite\//,
  /\0rollup\//,
];

export interface ResolveOptions {
  /** 项目根目录，用于计算业务源码的相对路径 */
  root?: string;
}

/** 去掉 Vite 的 query 后缀与 Windows 盘符差异 */
function stripMeta(source: string): string {
  const q = source.indexOf('?');
  const clean = q > 0 ? source.slice(0, q) : source;
  return clean.replace(/\\/g, '/');
}

/** 从 pnpm store 目录名解析出 { name, version } */
function parsePnpmDir(dir: string): { name: string; version: string } | null {
  // dir 形如 'lodash@4.17.21' 或 '@babel+runtime@7.24.0'
  const at = dir.lastIndexOf('@');
  if (at <= 0) return null;
  return {
    name: dir.slice(0, at).replace(/\+/g, '/'),
    version: dir.slice(at + 1),
  };
}

/**
 * 把单个 source 路径归一化成 { pkg, version, subPath, kind }。
 * 纯函数，无 IO —— 便于单测。
 */
export function resolveSource(source: string, opts: ResolveOptions = {}): ResolvedSource {
  const raw = source;

  if (!source || source.length === 0) {
    return { pkg: '<runtime>', kind: 'runtime', raw };
  }

  // Rollup / Vite 注入的虚拟模块
  if (source.charCodeAt(0) === 0 || source.startsWith('\\0')) {
    for (const re of BUILD_HELPERS) {
      if (re.test(source)) {
        return { pkg: '<rollup-helpers>', kind: 'virtual', subPath: source, raw };
      }
    }
    return { pkg: '<virtual>', kind: 'virtual', subPath: source, raw };
  }

  const clean = stripMeta(source);

  for (const re of BUILD_HELPERS) {
    if (re.test(clean)) {
      return { pkg: '<rollup-helpers>', kind: 'virtual', subPath: clean, raw };
    }
  }

  let version: string | undefined;
  const pnpmMatch = PNPM_STORE.exec(clean);
  if (pnpmMatch) {
    const parsed = parsePnpmDir(pnpmMatch[1]);
    if (parsed) version = parsed.version;
  }

  const idx = clean.lastIndexOf(NODE_MODULES);
  if (idx >= 0) {
    const rest = clean.slice(idx + NODE_MODULES.length);
    const parts = rest.split('/').filter(Boolean);
    if (parts.length === 0) {
      return { pkg: '<runtime>', kind: 'runtime', raw };
    }

    let pkg: string;
    let subParts: string[];
    if (parts[0].startsWith('@')) {
      // scope 包必须取两段
      pkg = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
      subParts = parts.slice(2);
    } else {
      pkg = parts[0];
      subParts = parts.slice(1);
    }

    // warn: pnpm store 目录名中的包名必须与真实包名一致，否则视为脏数据丢弃版本
    if (version) {
      const parsed = pnpmMatch ? parsePnpmDir(pnpmMatch[1]) : null;
      if (parsed && parsed.name !== pkg) version = undefined;
    }

    return {
      pkg,
      version,
      subPath: subParts.length ? subParts.join('/') : undefined,
      kind: 'npm',
      raw,
    };
  }

  // 业务源码
  let subPath = clean;
  if (opts.root) {
    const normalizedRoot = opts.root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (subPath.startsWith(normalizedRoot + '/')) {
      subPath = subPath.slice(normalizedRoot.length + 1);
    }
  }

  return { pkg: '@app', subPath, kind: 'app', raw };
}

/** 判断某个 source 是否属于指定包 */
export function sourceBelongsTo(source: string, pkg: string): boolean {
  return resolveSource(source).pkg === pkg;
}
