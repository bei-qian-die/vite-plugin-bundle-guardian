/**
 * 依赖图算法
 *
 * 四个能力：
 *   ① Tarjan 强连通分量 —— 循环依赖检测（迭代版，避免深图爆栈）
 *   ② BFS 最短引入链 —— `bundle-guardian why <pkg>` 的核心
 *   ③ 多版本重复依赖检测 —— pnpm / npm 嵌套布局都能识别
 *   ④ 未使用依赖检测 —— declared ∩ used 的差集
 */

import type {
  CircularDep,
  DuplicateGroup,
  ModuleNode,
  ResolvedSource,
  UnusedDependency,
} from './types.js';

export type AdjacencyMap = Map<string, string[]>;

export function buildAdjacency(nodes: ModuleNode[]): AdjacencyMap {
  const map: AdjacencyMap = new Map();
  for (const node of nodes) {
    map.set(node.id, node.importedIds.filter((id) => id && id !== node.id));
  }
  return map;
}

/* ────────────────────── ① Tarjan SCC ────────────────────── */

/**
 * 迭代版 Tarjan，返回所有强连通分量（长度 > 1 或自环的分量即依赖环）。
 * 复杂度 O(V + E)。
 */
export function tarjanSCC(adjacency: AdjacencyMap): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of adjacency.keys()) {
    if (index.has(root)) continue;

    // 手动维护 DFS 调用栈，frame.i 表示当前处理到第几个邻居
    const frames: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const neighbours = adjacency.get(frame.v) ?? [];

      if (frame.i < neighbours.length) {
        const w = neighbours[frame.i++];
        if (!adjacency.has(w)) continue; // 外部模块，不在图内

        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          frames.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
        continue;
      }

      // 该节点的所有邻居处理完毕，出栈
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].v;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.v)!));
      }
      if (low.get(frame.v) === index.get(frame.v)) {
        const component: string[] = [];
        let popped: string;
        do {
          popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== frame.v);
        components.push(component);
      }
    }
  }

  return components;
}

export interface CircularOptions {
  /** 忽略 node_modules 内部噪音（默认 true） */
  ignoreNodeModules?: boolean;
  /** 只返回前 N 个环，避免大项目刷屏 */
  limit?: number;
}

export function findCircularDependencies(
  adjacency: AdjacencyMap,
  options: CircularOptions = {}
): CircularDep[] {
  const { ignoreNodeModules = true, limit = 20 } = options;

  const components = tarjanSCC(adjacency);
  const result: CircularDep[] = [];

  for (const comp of components) {
    const selfLoop =
      comp.length === 1 && (adjacency.get(comp[0]) ?? []).includes(comp[0]);
    if (comp.length <= 1 && !selfLoop) continue;

    if (ignoreNodeModules && comp.every((id) => id.includes('node_modules'))) continue;

    result.push({ cycle: comp.reverse() });
    if (result.length >= limit) break;
  }

  return result;
}

/* ────────────────────── ② 最短引入链 ────────────────────── */

export interface RootsOptions {
  /**
   * 优先把「业务源码」当作根。
   * node_modules 内部有不少入度为 0 的文件（如 echarts 的 install*.js），
   * 若从它们起算，why 会直接停在第三方包内部，打不出真正有用的引入链。
   */
  preferApp?: boolean;
}

/** 入度为 0 的节点作为图的根（通常就是 entry 模块） */
export function findRoots(adjacency: AdjacencyMap, options: RootsOptions = {}): string[] {
  const inDegree = new Set<string>();
  for (const targets of adjacency.values()) {
    for (const t of targets) inDegree.add(t);
  }
  const zeroIn = [...adjacency.keys()].filter((id) => !inDegree.has(id));

  if (options.preferApp) {
    const appRoots = zeroIn.filter((id) => !id.includes('node_modules'));
    if (appRoots.length > 0) return appRoots;
  }

  return zeroIn.length > 0 ? zeroIn : [...adjacency.keys()].slice(0, 1);
}

/**
 * 从入口出发 BFS，找到第一条命中谓词的路径。
 * 返回完整的引入链（含起点与命中节点），找不到返回 null。
 */
export function findShortestPath(
  adjacency: AdjacencyMap,
  match: (id: string) => boolean,
  roots?: string[]
): string[] | null {
  const starts = roots && roots.length > 0 ? roots : findRoots(adjacency);
  const visited = new Set<string>();
  const parent = new Map<string, string | null>();
  const queue: string[] = [];

  for (const r of starts) {
    if (!adjacency.has(r)) continue;
    visited.add(r);
    parent.set(r, null);
    queue.push(r);
    if (match(r)) return [r];
  }

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);
      queue.push(next);
      if (match(next)) {
        return rebuildPath(parent, next);
      }
    }
  }

  return null;
}

function rebuildPath(parent: Map<string, string | null>, end: string): string[] {
  const path: string[] = [];
  let cursor: string | null | undefined = end;
  while (cursor) {
    path.push(cursor);
    cursor = parent.get(cursor);
  }
  return path.reverse();
}

/* ────────────────────── ③ 重复版本 ────────────────────── */

export interface DuplicateSource {
  pkg: string;
  version?: string;
  file: string;
  bytes?: number;
}

export function findDuplicatePackages(sources: DuplicateSource[]): DuplicateGroup[] {
  const byPkg = new Map<string, DuplicateGroup>();

  for (const src of sources) {
    if (!src.version || !src.pkg || src.pkg.startsWith('<')) continue;

    let group = byPkg.get(src.pkg);
    if (!group) {
      group = { pkg: src.pkg, versions: [], samples: {}, estimatedBytes: 0 };
      byPkg.set(src.pkg, group);
    }
    if (group.versions.includes(src.version)) {
      group.estimatedBytes += src.bytes ?? 0;
      continue;
    }
    group.versions.push(src.version);
    group.samples[src.version] = src.file;
    group.estimatedBytes += src.bytes ?? 0;
  }

  // 只保留真正出现多版本的包
  return [...byPkg.values()].filter((g) => g.versions.length > 1);
}

/* ────────────────────── ④ 未使用依赖 ────────────────────── */

export interface UnusedOptions {
  /**
   * 白名单：CLI 工具、postcss 插件、全局副作用包等不会被 import 但仍需保留
   */
  allowlist?: string[];
  /** 仅检查 dependencies，忽略 devDependencies（由调用方决定传什么进来） */
  detectedPkgs: Set<string>;
}

/**
 * 判断某个声明的依赖是否真的被引用。
 *
 * 不能只做精确匹配 —— 现实里「声明名」和「产物里的包名」常常不一致：
 *   vue                 → @vue/runtime-dom、@vue/reactivity、@vue/shared
 *   @babel/preset-env   → @babel/helper-*（子包）
 *   vue-router          → vue-router（一致）
 * 所以这里额外处理 @scope 前缀与子路径两种形态，避免把 vue 报成未使用。
 */
export function isDependencyUsed(declared: string, detected: Set<string>): boolean {
  if (detected.has(declared)) return true;

  for (const pkg of detected) {
    // 子路径：声明 lodash，产物里出现 lodash/merge.js
    if (pkg.startsWith(declared + '/')) return true;
    // @scope 子包：声明 vue，产物里出现 @vue/runtime-dom
    if (!declared.startsWith('@') && pkg.startsWith('@' + declared + '/')) return true;
    // 声明 @babel/core，产物里出现 @babel/core/…
    if (declared.startsWith('@') && pkg.startsWith(declared + '/')) return true;
  }
  return false;
}

export function findUnusedDependencies(
  declared: Record<string, string> | string[],
  options: UnusedOptions
): UnusedDependency[] {
  const allow = new Set(options.allowlist ?? []);
  const names = Array.isArray(declared) ? declared : Object.keys(declared ?? {});
  const out: UnusedDependency[] = [];

  for (const pkg of names) {
    if (allow.has(pkg)) continue;
    if (isDependencyUsed(pkg, options.detectedPkgs)) continue;
    out.push({
      pkg,
      reason: /^(postcss|babel-plugin|rollup-plugin|vite-plugin|eslint|@types\/)/.test(pkg)
        ? '工具链依赖，通常不需要直接 import（可加入 allowlist）'
        : '未在源码中发现任何 import',
    });
  }

  return out;
}

/** 把 ResolvedSource 列表转成去重后的包名集合 */
export function collectPkgNames(sources: ResolvedSource[]): Set<string> {
  const set = new Set<string>();
  for (const s of sources) {
    if (s.kind === 'npm' && !s.pkg.startsWith('<')) set.add(s.pkg);
  }
  return set;
}
