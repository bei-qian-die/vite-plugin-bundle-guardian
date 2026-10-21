/**
 * 离线场景下的模块图重建（启发式）
 *
 * 问题：插件在构建期能拿到 `this.getModuleInfo(id).importedIds`，图是精确的。
 * 但 CLI 直接分析一个 dist 目录时，只有 `*.js` + `*.js.map`，
 * sourcemap 里只有 sources 清单，**没有 import 关系** —— `why` 命令就没法用。
 *
 * 解法：用 sourcemap 的 sources 划定范围，再去读这些源文件，
 * 正则提取 import / export-from / dynamic import / require，重建一张近似图。
 * 这是启发式（会漏掉运行时拼接的路径），但足够支撑「谁引入了谁」的链路追溯。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ModuleNode } from './types.js';

const STATIC_RE = /(?:^|[\n;])\s*(?:import|export)\b[\s\S]{0,400}?\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const CANDIDATE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.mts', '/index.ts', '/index.js'];

export interface ScanOptions {
  /** 源码根目录，用于把相对 source 路径还原成绝对路径 */
  root?: string;
  /**
   * 路径别名（Vite 的 resolve.alias）。
   * 源码里 `from '@date'` 这种别名在产物里已消失，不告诉扫描器就接不上链路。
   */
  alias?: Record<string, string>;
  /** 需要跳过的目录名 */
  ignore?: string[];
}

/**
 * 从 sourcemap 的 sources 重建模块图。
 * @param sources 产物 sourcemap 里出现的源路径（可以是相对路径）
 * @param baseDir 解析相对 source 的基准目录（通常是产物所在目录）
 */
export function scanModuleGraph(
  sources: Iterable<string>,
  baseDir: string,
  options: ScanOptions = {}
): ModuleNode[] {
  const alias = options.alias ?? {};
  const ignore = options.ignore ?? ['node_modules', '.git', 'dist'];

  // ① 归一化成绝对路径，并建立「绝对路径 → 源文件」索引
  const absList: string[] = [];
  const seen = new Set<string>();

  for (const raw of sources) {
    if (!raw) continue;
    const abs = path.isAbsolute(raw) ? normalize(raw) : normalize(path.resolve(baseDir, raw));
    if (seen.has(abs)) continue;
    seen.add(abs);
    absList.push(abs);
  }

  const sourceSet = new Set(absList);
  // bare specifier → 命中的源文件（一个包只取一个代表，够 why 用）
  const pkgIndex = buildPackageIndex(absList);

  const graph: ModuleNode[] = [];

  for (const file of absList) {
    const importedIds: string[] = [];

    // node_modules（以及 dist 等）里的文件仍然要作为**节点**保留 ——
    // 它们是 why 链路的终点；只是没必要再去解析它们内部的 import（量大且没有价值）。
    const shouldParse = !ignore.some((dir) => file.includes(`/${dir}/`));

    if (shouldParse) {
      let code: string;
      try {
        code = fs.readFileSync(file, 'utf8');
      } catch {
        code = ''; // 虚拟模块 / 已被删除的文件：保留节点，放弃边
      }

      if (code) {
        const push = (spec: string) => {
          const target = resolveSpecifier(spec, file, sourceSet, pkgIndex, alias);
          if (target && !importedIds.includes(target)) importedIds.push(target);
        };
        matchAll(code, STATIC_RE, push);
        matchAll(code, BARE_IMPORT_RE, push);
        matchAll(code, DYNAMIC_RE, push);
        matchAll(code, REQUIRE_RE, push);
      }
    }

    graph.push({ id: file, importedIds });
  }

  return graph;
}

function matchAll(code: string, re: RegExp, fn: (value: string) => void): void {
  const local = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = local.exec(code)) !== null) {
    fn(m[1]);
  }
}

/** 把 bare specifier 映射到 sourcemap 里真实出现过的文件 */
function buildPackageIndex(files: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of files) {
    const idx = file.lastIndexOf('/node_modules/');
    if (idx < 0) continue;
    const rest = file.slice(idx + '/node_modules/'.length);
    const parts = rest.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const name = parts[0].startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
    // pnpm store 的目录名形如 .pnpm/lodash@4.17.21/node_modules/lodash/...
    if (name === '.pnpm' || name.startsWith('.')) continue;

    // 一个包会对应几十个源文件，优先取层级最浅的那个（通常是包入口）
    const existing = index.get(name);
    if (!existing || depth(file) < depth(existing)) index.set(name, file);
  }
  return index;
}

/** 路径层级，用来挑包入口（越浅越像入口） */
function depth(file: string): number {
  return file.split('/').length;
}

function resolveSpecifier(
  spec: string,
  fromFile: string,
  sourceSet: Set<string>,
  pkgIndex: Map<string, string>,
  alias: Record<string, string> = {}
): string | null {
  // 路径别名优先：构建后别名已消失，只能靠外部告知
  for (const [key, target] of Object.entries(alias)) {
    if (spec === key || spec.startsWith(key + '/')) {
      const mapped = spec.replace(key, target);
      const hit = resolveLocal(mapped, fromFile, sourceSet);
      if (hit) return hit;
    }
  }

  // 相对路径 / 绝对路径
  const local = resolveLocal(spec, fromFile, sourceSet);
  if (local) return local;

  // bare specifier（包名）
  const hit = pkgIndex.get(spec);
  if (hit) return hit;

  // 包名带子路径：lodash/merge.js → 先精确找，再退回包入口
  const scoped = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  return pkgIndex.get(scoped) ?? null;
}

function resolveLocal(spec: string, fromFile: string, sourceSet: Set<string>): string | null {
  // 注意要用 path.isAbsolute：Windows 下别名展开出来是 "C:/..."，不是以 / 开头
  if (path.isAbsolute(spec) || spec.startsWith('.')) {
    const base = path.isAbsolute(spec) ? spec : path.resolve(path.dirname(fromFile), spec);
    for (const ext of CANDIDATE_EXTS) {
      const candidate = normalize(base + ext);
      if (sourceSet.has(candidate)) return candidate;
    }
  }
  return null;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\?.*$/, '');
}

/** 从 bundle 里收集所有 sourcemap 的 source 清单（CLI 用） */
export function collectSourcePaths(
  maps: Array<{ sources?: string[] } | null | undefined>
): Set<string> {
  const out = new Set<string>();
  for (const map of maps) {
    for (const s of map?.sources ?? []) out.add(s);
  }
  return out;
}
